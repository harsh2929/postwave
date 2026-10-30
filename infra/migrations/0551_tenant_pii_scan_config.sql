-- 0551_tenant_pii_scan_config.sql
--
-- SUB-071 — Shadow-PII discovery via AI scan (scan config table).
--
-- Why this migration:
--   The shadow-PII scanner (0550 findings) needs a per-tenant on/off switch and
--   an optional background schedule so a DPO can enable continuous scanning
--   without a code change. This table holds one row per tenant: scan_enabled
--   plus an optional cron schedule the background worker reads. Absent row =
--   scanning disabled (the conservative default — a tenant that never opts in
--   gets no scan).
--
-- rollback-strategy: additive. Hard rollback = DROP TABLE tenant_pii_scan_config.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_pii_scan_config (
    tenant_id       uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    -- Master on/off for the background scanner. Default false = opt-in only.
    scan_enabled    boolean NOT NULL DEFAULT false,
    -- Optional cron expression the background worker honours when scan_enabled.
    -- NULL = no schedule (scan only runs on write-path / manual trigger).
    scan_schedule   text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenant_pii_scan_config IS
    'SUB-071 per-tenant shadow-PII scanner config: enable flag + optional cron schedule.';

CREATE TRIGGER tenant_pii_scan_config_set_updated_at
    BEFORE UPDATE ON tenant_pii_scan_config
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_pii_scan_config TO postwave_app;

ALTER TABLE tenant_pii_scan_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_pii_scan_config FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_pii_scan_config
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON tenant_pii_scan_config
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
