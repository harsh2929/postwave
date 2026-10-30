-- 1977_engagement_honeypot_fetches.sql
--
-- Storage for the one kind of machine ground truth this platform can obtain
-- from live traffic.
--
-- The calibration harness (engagementclassification/calibration.go) splits
-- evidence into certifying and diagnostic, and deliberately demotes seed-fleet
-- machine labels to diagnostic: seed identity is an absolute classifier input,
-- so measuring the classifier against seeds asks it to agree with something it
-- was told. Its own methodology note names what would close the gap — "non-seed
-- controlled-machine examples estimate machine recall" — and until now nothing
-- could produce one. Every machine label we had came from a seed.
--
-- A honeypot decoy is a link no human can reach, embedded in ordinary mail to
-- ordinary recipients. Anything that fetches it is a machine, the recipient is
-- real rather than seeded, and seed identity plays no part, so the label
-- certifies without circularity. These rows are that evidence.
--
-- Deliberately NOT subscriber_events. A honeypot fetch must never become a
-- `clicked` engagement event: it would inflate the click-through rate reported
-- to the operator and feed a machine action into lead scoring and send-time
-- optimisation. A measurement instrument that changes the thing it measures is
-- worse than no instrument, so the evidence lives in its own table that no
-- reporting path reads.
--
-- No recipient address is stored. The decoy URL carries the same recipient
-- HMAC the rest of the engagement pipeline uses, so a corpus exported from
-- these rows can be handed to an analyst with no right to the mailing list.
--
-- rollback-strategy: restore. Dropping this table discards accrued ground
-- truth that cannot be regenerated — the fetches happened at a moment in a
-- scanner population that no longer exists, and a re-send would sample a
-- different world.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS engagement_honeypot_fetches (
    id                      bigserial PRIMARY KEY,
    tenant_id               uuid        NOT NULL,
    campaign_id             uuid        NOT NULL,
    recipient_identity_hmac text        NOT NULL,
    -- The hiding method, stored per row because the VALIDITY of the label
    -- depends on it and a corpus built years from now must re-derive that
    -- validity from the evidence rather than from a build-time assumption.
    -- Off-screen (sr-only) decoys are reachable by a screen reader, so a fetch
    -- of one may be a blind recipient; such rows must never certify.
    technique               text        NOT NULL,
    token_issued_at         timestamptz NOT NULL,
    fetched_at              timestamptz NOT NULL,
    user_agent              text,
    ip                      text,
    network_asn             bigint,
    network_asn_source      text,
    network_region          text,
    reverse_dns             text,
    tls_ja4                 text,
    created_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT engagement_honeypot_fetches_hmac_hex
        CHECK (recipient_identity_hmac ~ '^[0-9a-f]{64}$'),
    -- A closed vocabulary in the database, not only in Go. These rows are read
    -- by the corpus exporter to build certification evidence; an unrecognised
    -- technique arriving by any path at all must be rejected at write time
    -- rather than silently trusted at read time.
    CONSTRAINT engagement_honeypot_fetches_technique
        CHECK (technique IN ('display_none', 'html_comment', 'off_screen', 'zero_size', 'color_match')),
    CONSTRAINT engagement_honeypot_fetches_asn_source
        CHECK (network_asn IS NULL OR network_asn_source IS NOT NULL)
);

-- One row per recipient per campaign per technique. A scanner fetches both
-- decoys and retries, and a gateway may re-scan days later; those are all the
-- same underlying fact. Keeping the FIRST arrival is what the exporter wants:
-- it is the fetch whose latency relative to delivery still means something.
CREATE UNIQUE INDEX IF NOT EXISTS engagement_honeypot_fetches_unit
    ON engagement_honeypot_fetches (tenant_id, campaign_id, recipient_identity_hmac, technique);

-- The exporter sweeps a tenant's evidence for a period.
CREATE INDEX IF NOT EXISTS engagement_honeypot_fetches_sweep
    ON engagement_honeypot_fetches (tenant_id, fetched_at);

ALTER TABLE engagement_honeypot_fetches ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_honeypot_fetches FORCE ROW LEVEL SECURITY;

-- NULLIF before the cast: current_setting(..., true) returns '' when the GUC is
-- unset, and ''::uuid raises rather than returning no rows, which turns a
-- missing tenant scope into a 500 instead of an empty result.
--
-- PERMISSIVE, not RESTRICTIVE. Restrictive policies only SUBTRACT from what a
-- permissive one already allows, so a table carrying only restrictive policies
-- denies everything — including the INSERT this exists to permit.
--
-- The public decoy endpoint is unauthenticated, but the tenant it writes under
-- is taken from the HMAC-signed token rather than from anything the caller
-- says, so the scope here is as trustworthy as any authenticated path.
DROP POLICY IF EXISTS engagement_honeypot_fetches_tenant ON engagement_honeypot_fetches;
CREATE POLICY engagement_honeypot_fetches_tenant ON engagement_honeypot_fetches
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- bigserial does not carry its own grant: without this the INSERT fails on
-- nextval even though the table grant is present.
GRANT SELECT, INSERT, UPDATE, DELETE ON engagement_honeypot_fetches TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE engagement_honeypot_fetches_id_seq TO postwave_app;

COMMIT;
