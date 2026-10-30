-- 0450_tenant_custom_field_settings.sql
--
-- SUB-015 — Custom-field governance settings (per-tenant overrides).
--
-- Migration 0449 put the two soft-limit knobs (max_custom_fields,
-- max_searchable_fields) directly on the tenants table with tier-agnostic
-- defaults. This migration establishes a dedicated, tenant-scoped settings
-- table so the governance surface is extensible: an admin can override the
-- limits per workspace (via PUT /api/v1/settings/custom-fields) and future
-- work can hang additional governance policy (per-tier defaults, naming
-- conventions, approval workflow) off the same row without re-shaping tenants.
--
-- The table holds at most one row per tenant (enforced by a unique tenant_id
-- index). When a row is absent, the effective limits fall back to the tenants
-- columns from 0449; when present, the row's values win. The read endpoint
-- COALESCEs the two so callers always see a single resolved pair of limits.
--
-- Tenant-scoped table → tenant_id uuid + RLS, with the GUC read via
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid so an unset GUC
-- does not crash the policy. Shape copied from 0036_custom_fields.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_custom_field_settings (
    id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    max_custom_fields     integer     NOT NULL DEFAULT 1000,
    max_searchable_fields integer     NOT NULL DEFAULT 3,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenant_custom_field_settings_bounds_chk
        CHECK (max_custom_fields >= 0 AND max_searchable_fields >= 0)
);

-- At most one settings row per tenant. Drives the upsert used by the
-- admin PUT endpoint (ON CONFLICT (tenant_id) DO UPDATE).
CREATE UNIQUE INDEX IF NOT EXISTS tenant_custom_field_settings_tenant_idx
    ON tenant_custom_field_settings (tenant_id);

CREATE TRIGGER tenant_custom_field_settings_set_updated_at
    BEFORE UPDATE ON tenant_custom_field_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_custom_field_settings TO postwave_app;

ALTER TABLE tenant_custom_field_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_custom_field_settings FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_custom_field_settings
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
