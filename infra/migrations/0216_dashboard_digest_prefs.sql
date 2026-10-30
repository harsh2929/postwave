-- 0216_dashboard_digest_prefs.sql
--
-- Refined Dashboard PR 3: per-user preference for the dashboard
-- email digest. Frequency = off|daily|weekly. The actual sender is
-- a follow-up (PR 3 ships the preference storage + UI so users can
-- opt in; the worker that consumes this table lands later).
--
-- We key on (user_id, tenant_id) so a user who belongs to multiple
-- workspaces can have different cadences per workspace.

BEGIN;

CREATE TABLE dashboard_digest_prefs (
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    frequency    text NOT NULL DEFAULT 'off'
                 CHECK (frequency IN ('off', 'daily', 'weekly')),
    last_sent_at timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, tenant_id)
);

ALTER TABLE dashboard_digest_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_digest_prefs FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON dashboard_digest_prefs
    AS RESTRICTIVE
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON dashboard_digest_prefs TO postwave_app;

COMMIT;
