-- 0252_segment_static_freezes.sql
--
-- GAP-LS-069: convert a dynamic segment into a static one at a point
-- in time ("list freeze" / "change list type" in HubSpot;
-- AUD-04 snapshot in Klaviyo). A frozen segment captures its
-- membership at the moment of freeze, then never re-evaluates —
-- useful for "use this exact audience for the holiday campaign even
-- if the underlying predicate drifts overnight."
--
-- NOTE: the existing `segment_snapshots` table (0201) is a different
-- concept — Klaviyo's count/sample cache for the predicate
-- registry. We use a distinct name (segment_static_freezes) so the
-- two don't collide and so the intent is clear at every callsite.
--
-- Two tables:
--   - segment_static_freezes: header row per freeze event
--     (segment_id, frozen_at, name, member_count).
--   - segment_static_freeze_members: join table with one row per
--     frozen subscriber. Cleaner than a bytea[] of email hashes for
--     export + RLS + tenant-scoped queries.
--
-- The freeze worker (lands later) queries the source segment, writes
-- the header + member rows in a single tx, returns the freeze id.

BEGIN;

CREATE TABLE IF NOT EXISTS segment_static_freezes (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source_segment_id   uuid NOT NULL,
    name                text NOT NULL,
    description         text NOT NULL DEFAULT '',
    frozen_at           timestamptz NOT NULL DEFAULT now(),
    frozen_by           uuid,
    member_count        int NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS segment_static_freezes_tenant_source_idx
    ON segment_static_freezes (tenant_id, source_segment_id, frozen_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON segment_static_freezes TO postwave_app;

ALTER TABLE segment_static_freezes ENABLE ROW LEVEL SECURITY;
ALTER TABLE segment_static_freezes FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON segment_static_freezes
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON segment_static_freezes
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Join table: one row per frozen subscriber. tenant_id denormalized
-- for RLS without a parent-row JOIN. ON DELETE CASCADE on the freeze
-- header cleans the join automatically.
CREATE TABLE IF NOT EXISTS segment_static_freeze_members (
    freeze_id       uuid NOT NULL REFERENCES segment_static_freezes(id) ON DELETE CASCADE,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id   uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    email           citext NOT NULL,
    added_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (freeze_id, subscriber_id)
);

CREATE INDEX IF NOT EXISTS segment_static_freeze_members_tenant_idx
    ON segment_static_freeze_members (tenant_id, freeze_id);

CREATE INDEX IF NOT EXISTS segment_static_freeze_members_email_idx
    ON segment_static_freeze_members (tenant_id, email);

GRANT SELECT, INSERT, DELETE ON segment_static_freeze_members TO postwave_app;

ALTER TABLE segment_static_freeze_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE segment_static_freeze_members FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON segment_static_freeze_members
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON segment_static_freeze_members
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
