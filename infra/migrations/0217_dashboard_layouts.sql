-- 0217_dashboard_layouts.sql
--
-- Refined Dashboard PR 4: per-user, per-workspace ordering of the
-- StatCards on /dashboard. The layout is a JSONB array of card keys
-- ("subs" | "opens" | "clicks" | "bounces" | future). Server returns
-- defaults when nothing is saved.
--
-- Why per-tenant: a power user with multiple workspaces will care
-- about different metrics in each. Keying on (user, tenant) lets
-- them have a different layout per workspace.

BEGIN;

CREATE TABLE dashboard_layouts (
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    layout     jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, tenant_id)
);

ALTER TABLE dashboard_layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_layouts FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON dashboard_layouts
    AS RESTRICTIVE
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON dashboard_layouts TO postwave_app;

COMMIT;
