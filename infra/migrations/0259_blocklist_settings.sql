-- 0259_blocklist_settings.sql
--
-- Additive companion migration for Wave-3 modernization:
--
-- 1. blocklist_settings : per-tenant flag for blocklist auto-suppress.
--    Replaces the global env var POSTWAVE_BLOCKLIST_AUTO_SUPPRESS with
--    a tenant-scoped toggle so each workspace can opt in/out (GAP-LS
--    Wave-3 audit). A row only exists once a tenant has expressed a
--    preference; the read path treats missing rows as "false".
--
-- 2. control_groups : tenant-wide persistent control cohorts for
--    incremental-lift measurement (GAP-LS-138). Distinct from
--    campaign_holdouts (per-campaign): a control group sits across all
--    campaigns until the operator dissolves it. Per-subscriber
--    membership is computed deterministically as
--      md5(seed || subscriber_id) ranged into [0, 100)
--    and stays stable across re-evaluations.
--
-- Both tables follow the canonical Postwave RLS GUC idiom
--   NULLIF(current_setting('app.tenant_id', true), '')::uuid
-- so unset GUC reads/writes return zero rows / are blocked.

BEGIN;

-- 1. blocklist_settings -------------------------------------------------

CREATE TABLE IF NOT EXISTS blocklist_settings (
    tenant_id      uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    auto_suppress  boolean NOT NULL DEFAULT false,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER blocklist_settings_set_updated_at
    BEFORE UPDATE ON blocklist_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON blocklist_settings TO postwave_app;

ALTER TABLE blocklist_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocklist_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON blocklist_settings
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON blocklist_settings
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2. control_groups -----------------------------------------------------

CREATE TABLE IF NOT EXISTS control_groups (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name           text NOT NULL,
    description    text NOT NULL DEFAULT '',
    -- Percent of the tenant's subscriber base held out across ALL
    -- campaigns. Bounded 0..50 to prevent operator footgun (a 60%
    -- control would make every send a waste).
    percent        numeric(5,2) NOT NULL CHECK (percent >= 0 AND percent <= 50),
    -- Deterministic seed for stable in/out assignment.
    seed           text NOT NULL,
    status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','paused','dissolved')),
    starts_at      timestamptz NOT NULL DEFAULT now(),
    ends_at        timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS control_groups_tenant_status_idx
    ON control_groups (tenant_id, status, starts_at DESC);

CREATE TRIGGER control_groups_set_updated_at
    BEFORE UPDATE ON control_groups
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON control_groups TO postwave_app;

ALTER TABLE control_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_groups FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON control_groups
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON control_groups
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
