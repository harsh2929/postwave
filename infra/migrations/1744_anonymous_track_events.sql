-- 1744_anonymous_track_events.sql
--
-- G-20b — public anonymous event ingestion.
--
-- POST /api/public/track/event (SUB-122, migration-adjacent package
-- internal/publictrack) requires an email/external_id because it writes onto
-- the known-subscriber timeline via subscribers.RecordSubscriberEvent. That
-- leaves no public path to record activity for a visitor we have not
-- identified yet (page views, add-to-cart, etc. before an email is handed
-- over) — every CDP-grade competitor (Segment, Klaviyo "Active on Site")
-- supports this. This migration adds the anonymous-only sibling store.
--
-- subscriber_anonymous_profiles (migration 0451) already tracks the
-- anonymous_id -> subscriber_id stitch produced by an identify call; this
-- table is the raw anonymous activity itself, keyed purely on anonymous_id
-- with no subscriber row required (and never creates one — abuse surface).
-- attributed_at is populated once a stitch producer (see
-- subscribers.Repo.AttributeAnonymousEvents) has copied a row onto the
-- known-subscriber timeline, so a repeated identify does not duplicate it.
--
-- rollback-strategy: additive. Hard rollback = DROP TABLE
-- subscriber_anonymous_events.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_anonymous_events (
    id            bigserial PRIMARY KEY,
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    anonymous_id  text NOT NULL CHECK (char_length(anonymous_id) BETWEEN 1 AND 512),
    event_name    text CHECK (event_name IS NULL OR char_length(event_name) <= 128),
    event_type    text NOT NULL DEFAULT 'custom' CHECK (char_length(event_type) BETWEEN 1 AND 64),
    properties    jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Client-supplied idempotency key, mirroring subscriber_events'
    -- source_event_id. NULL is permitted (no attempted dedup) and multiple
    -- NULLs never collide under the UNIQUE constraint below, matching
    -- Postgres NULL-distinctness semantics used the same way by
    -- subscriber_event_dedup_keys.
    source_event_id text,
    occurred_at   timestamptz NOT NULL DEFAULT now(),
    -- Set once subscribers.Repo.AttributeAnonymousEvents has copied this row
    -- onto a now-known subscriber's timeline (the SUB-003 stitch producer).
    -- NULL = not yet attributed.
    attributed_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT subscriber_anonymous_events_dedup_unique
        UNIQUE (tenant_id, anonymous_id, source_event_id)
);

-- "All anonymous events for anonymous_id X" — the hot read path for both the
-- public ingest dedup lookup and the identify-time stitch producer.
CREATE INDEX IF NOT EXISTS subscriber_anonymous_events_tenant_anon_idx
    ON subscriber_anonymous_events (tenant_id, anonymous_id);

-- Narrow the stitch producer's scan to rows it hasn't copied yet.
CREATE INDEX IF NOT EXISTS subscriber_anonymous_events_unattributed_idx
    ON subscriber_anonymous_events (tenant_id, anonymous_id, occurred_at)
    WHERE attributed_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_anonymous_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE subscriber_anonymous_events_id_seq TO postwave_app;

ALTER TABLE subscriber_anonymous_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_anonymous_events FORCE  ROW LEVEL SECURITY;

-- Tenant-RLS via the app.tenant_id NULLIF idiom (raw ::uuid cast on an unset
-- GUC raises; NULLIF('', ...) yields NULL so the comparison fails closed
-- instead of erroring for connections that never set the GUC).
CREATE POLICY tenant_isolation ON subscriber_anonymous_events
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscriber_anonymous_events
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
