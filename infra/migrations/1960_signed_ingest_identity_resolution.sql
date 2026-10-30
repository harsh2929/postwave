-- Identity resolution and all-touches storage for the signed conversion ingest
-- (PRD F03).
--
-- WHY THIS EXISTS
--
-- Migration 1944 gave conversions three identity columns — email_sha256,
-- click_id, external_id — and the signed ingest has faithfully written them ever
-- since. Nothing ever READ them. A server-to-server conversion therefore landed
-- with subscriber_email NULL, campaign_id NULL and attributed_via = 'none': the
-- money was recorded and could not be credited to a person, a campaign, a flow
-- or a form. The three columns were a place to put an answer with no question
-- attached to them.
--
-- Resolving them needs two things the schema could not express:
--
--   1. A way to go from sha256(lower(email)) back to a subscriber. subscribers
--      stores the address as citext and nothing stored its digest, so the
--      lookup either scanned the whole table per conversion or was impossible.
--      An expression index makes it a single probe without adding a duplicate,
--      separately-maintained hash column that could drift from the address it
--      claims to describe.
--
--   2. A way to go from a click id back to the person and campaign that click
--      belonged to. A click id names a DEVICE/LINK TOUCH, not a person, and no
--      table in this schema bound one to a subscriber. Without that binding
--      click_id resolution can only ever miss, which is indistinguishable at
--      report time from "this customer sends no click ids".
--
-- And one thing the PRD asks for directly: recording every touch that could
-- have contributed rather than only the winning one.
--
-- rollback-strategy: no-op
--
-- Every object here is additive (two new tables, one expression index, grants).
-- Dropping them would only return the ingest to writing identity it never
-- reads, so there is nothing to undo on the data path; a rollback is achieved
-- by reverting the application, not by mutating the schema.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 1. sha256(lower(email)) -> subscriber, as an index rather than a column.
-- ---------------------------------------------------------------------------
--
-- The digest is DERIVED, so it is expressed as a derivation. A stored
-- email_sha256 column on subscribers would need a trigger to stay correct
-- across every address change, merge and import path in this codebase, and the
-- day one of those paths forgets, a subscriber silently stops being resolvable
-- while still looking perfectly healthy in every read. An expression index
-- cannot drift: PostgreSQL recomputes it on every write of the row.
--
-- lower() matches the PRD's client-side contract verbatim ("lowercased and
-- trimmed before hashing"). email is citext — compared case-insensitively but
-- STORED with whatever case it arrived in — so lower() is load-bearing, not
-- decoration: without it 'Buyer@example.test' and 'buyer@example.test' hash to
-- different digests and one of the two customers never resolves.
CREATE INDEX IF NOT EXISTS subscribers_email_sha256_idx
    ON subscribers (tenant_id, encode(digest(lower(email::text), 'sha256'), 'hex'));

-- ---------------------------------------------------------------------------
-- 2. click_id -> (subscriber, campaign): the binding a click id needs to mean
--    anything.
-- ---------------------------------------------------------------------------
--
-- A separate table rather than a column on subscribers, because the
-- relationship is many-to-one and time-stamped: one person accumulates many
-- click ids, each naming a different link touch on a different campaign at a
-- different moment, and collapsing them onto the subscriber would destroy the
-- very sequence attribution is computed from.
--
-- `source` records HOW the binding was learned, because the two producers carry
-- different strength and a later model must be able to weigh them apart:
--
--   'link_click'                — the tracked-link redirect issued this click
--                                 id to this recipient for this campaign. The
--                                 binding is authoritative; it names the
--                                 campaign as well as the person.
--   'signed_ingest_observation' — a signed conversion arrived carrying BOTH a
--                                 click id and a stronger identifier (an email
--                                 digest or an external id) that resolved. The
--                                 customer's own server asserted that both name
--                                 the same event, so the click id is now known
--                                 to belong to that subscriber. It does NOT name a
--                                 campaign: the observation says who, never
--                                 which message.
--
-- Recording the weaker observation is what makes the feed self-improving: the
-- next conversion that carries only that click id resolves, where today it
-- would land anonymous forever.
CREATE TABLE IF NOT EXISTS conversion_click_identities (
    id            bigserial PRIMARY KEY,
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    click_id      text NOT NULL,
    -- CASCADE, not SET NULL: a binding whose subscriber is gone resolves to
    -- nobody, and keeping the orphan row would only make erased people
    -- re-resolvable as NULL through a key the customer still holds.
    subscriber_id uuid REFERENCES subscribers(id) ON DELETE CASCADE,
    -- SET NULL: a deleted campaign must not delete the person-binding. The
    -- click still happened and still identifies the subscriber.
    campaign_id   uuid REFERENCES campaigns(id) ON DELETE SET NULL,
    clicked_at    timestamptz NOT NULL DEFAULT now(),
    source        text NOT NULL DEFAULT 'link_click'
                  CHECK (source IN ('link_click', 'signed_ingest_observation')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One click id names one link touch, so it names at most one binding. This is
-- also the ON CONFLICT target that makes recording an observation idempotent
-- under the retries a conversion feed is built to expect.
CREATE UNIQUE INDEX IF NOT EXISTS conversion_click_identities_click_uniq
    ON conversion_click_identities (tenant_id, click_id);

CREATE INDEX IF NOT EXISTS conversion_click_identities_subscriber_idx
    ON conversion_click_identities (tenant_id, subscriber_id, clicked_at DESC)
    WHERE subscriber_id IS NOT NULL;

ALTER TABLE conversion_click_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_click_identities FORCE ROW LEVEL SECURITY;

-- FOR ALL, with both USING and WITH CHECK. RLS FILTERS, it does not refuse: a
-- policy covering only SELECT would let an UPDATE or DELETE match zero rows and
-- report success, which on an attribution ledger means a correction that
-- silently never happened.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'conversion_click_identities'
           AND policyname = 'tenant_isolation'
    ) THEN
        CREATE POLICY tenant_isolation ON conversion_click_identities
            FOR ALL
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. All-touches storage: every touch that could have contributed.
-- ---------------------------------------------------------------------------
--
-- Attribution stores ONE answer on the conversion row: campaign_id plus the
-- attributed_via that says how it was reached. That is the right shape for a
-- fact table and the wrong shape for a model, because it destroys the evidence
-- the answer was derived from. Today's last-touch rule picks the most recent
-- in-window click and forgets the other four; the day somebody wants
-- first-touch, linear or time-decay credit, the inputs are gone and the only
-- way to recover them is to re-ingest conversions that arrived months ago —
-- which no customer can do, because their commerce system no longer holds them.
--
-- So the inputs are kept. Two kinds of evidence, one table, because
-- recomputation needs BOTH and splitting them would mean every model
-- reimplementing the same two-way join:
--
--   touch_kind = 'identity'        one row per identifier the payload carried,
--                                  with the subscriber it resolved to (NULL
--                                  when it resolved to nothing) and the
--                                  resolution_rank it held. This is what makes
--                                  a DIFFERENT resolution order recomputable:
--                                  the losing identifiers and what they would
--                                  have resolved to are still here.
--
--   touch_kind = 'campaign_click'  one row per in-window click by the resolved
--                                  subscriber — not only the most recent. This
--                                  is what makes a different ATTRIBUTION MODEL
--                                  recomputable, since first-touch and linear
--                                  need exactly the clicks last-touch discarded.
--
-- is_winner marks which row produced what the conversion actually stored, so a
-- recomputation can be diffed against the shipped answer instead of merely
-- replacing it. Without it "what changed" would be unanswerable.
--
-- The shape CHECK is what stops this from degenerating into a bag of nullable
-- columns: each kind must carry the fields its kind is defined by, so a row
-- that claims to be a campaign click can never exist without a campaign or a
-- time to place it in the sequence.
CREATE TABLE IF NOT EXISTS conversion_attribution_touches (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    conversion_id   bigint NOT NULL REFERENCES conversions(id) ON DELETE CASCADE,
    touch_kind      text NOT NULL CHECK (touch_kind IN ('identity', 'campaign_click')),
    -- identity rows: which identifier, its value AS PRESENTED, and the priority
    -- position it held at ingest (1 = email_sha256, 2 = click_id,
    -- 3 = external_id). Never a plaintext address: the digest is what the wire
    -- carried and the digest is what is kept.
    identity_kind   text CHECK (identity_kind IN ('email_sha256', 'click_id', 'external_id')),
    identity_value  text,
    resolution_rank int,
    -- SET NULL rather than CASCADE: erasing a person must remove the linkage
    -- while leaving the fact that a touch occurred, so revenue totals do not
    -- silently change when a subscriber exercises erasure.
    subscriber_id   uuid REFERENCES subscribers(id) ON DELETE SET NULL,
    campaign_id     uuid REFERENCES campaigns(id) ON DELETE SET NULL,
    touched_at      timestamptz,
    is_winner       boolean NOT NULL DEFAULT false,
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT conversion_attribution_touches_shape CHECK (
        (touch_kind = 'identity'
            AND identity_kind IS NOT NULL
            AND identity_value IS NOT NULL
            AND resolution_rank IS NOT NULL)
        OR
        (touch_kind = 'campaign_click'
            AND campaign_id IS NOT NULL
            AND touched_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS conversion_attribution_touches_conversion_idx
    ON conversion_attribution_touches (tenant_id, conversion_id, touch_kind);

-- The recomputation read path: every touch for a campaign over a window.
CREATE INDEX IF NOT EXISTS conversion_attribution_touches_campaign_idx
    ON conversion_attribution_touches (tenant_id, campaign_id, touched_at DESC)
    WHERE campaign_id IS NOT NULL;

ALTER TABLE conversion_attribution_touches ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_attribution_touches FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'conversion_attribution_touches'
           AND policyname = 'tenant_isolation'
    ) THEN
        CREATE POLICY tenant_isolation ON conversion_attribution_touches
            FOR ALL
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Grants.
-- ---------------------------------------------------------------------------
--
-- bigserial needs its own sequence grant. Table INSERT alone leaves the default
-- nextval() unprivileged and every insert fails at runtime with a permission
-- error that names the sequence, not the table.
GRANT SELECT, INSERT, UPDATE, DELETE ON conversion_click_identities TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE conversion_click_identities_id_seq TO postwave_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON conversion_attribution_touches TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE conversion_attribution_touches_id_seq TO postwave_app;
