-- 1777_activity_cursor.sql
--
-- Cross-device "resume where you left off" (Apple-level integration blueprint,
-- Phase 1 — Continuity). One row per (tenant, user) records the single most
-- recently viewed entity as a @postwave/route-map (entity_key, entity_id) pair
-- — the same contract that already backs the web "Copy link / open in app"
-- control. A user who opens a campaign on desktop can be offered "Continue —
-- Campaign X" on web or mobile, because the cursor is server-side, not a
-- per-device silo. It stores an ID reference only (never entity content), so
-- it carries no customer PII.
--
-- rollback-strategy: expand-contract — a new isolated table; DROP TABLE
-- restores the prior shape with no dependents.

BEGIN;

CREATE TABLE IF NOT EXISTS activity_cursor (
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Recipient (users.id). No FK so a user delete doesn't block; tenant
    -- cascade is sufficient. Handlers always pin user_id to the session user.
    user_id     uuid NOT NULL,
    -- @postwave/route-map entity key (e.g. 'campaign', 'subscriber') and its
    -- opaque resource id. Bounded so a crafted value can't bloat the row.
    entity_key  text NOT NULL CHECK (length(entity_key) BETWEEN 1 AND 64),
    entity_id   text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 256),
    viewed_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON activity_cursor TO postwave_app;

ALTER TABLE activity_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_cursor FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON activity_cursor
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON activity_cursor
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
