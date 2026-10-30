-- 0410_segment_pnl_cost_config.sql
--
-- Segment P&L (feature #4, "Segment P&L"): the per-tenant cost schedule
-- that turns observed revenue into NET CONTRIBUTION. One row per tenant
-- (tenant-wide defaults per approved decision D3 — per-segment overrides
-- are a follow-up nullable FK, deliberately out of scope here).
--
-- All values are in minor currency units (cents) for the tenant's
-- primary currency. Everything DEFAULTs to zero so the first P&L report
-- renders without operator config; the cost side is transparently
-- labelled "no cost config set" in the UI when defaults are in use
-- (cost_config_present=false) rather than silently implying $0 net is
-- correct.
--
-- rollback-strategy: no-op — additive table; prior releases never read
-- it, so leaving it in place during a rollback is safe.

BEGIN;

CREATE TABLE IF NOT EXISTS segment_pnl_cost_config (
    tenant_id            uuid        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    unsub_cost_cents     integer     NOT NULL DEFAULT 0 CHECK (unsub_cost_cents >= 0),
    complaint_cost_cents integer     NOT NULL DEFAULT 0 CHECK (complaint_cost_cents >= 0),
    sms_send_cost_cents  integer     NOT NULL DEFAULT 0 CHECK (sms_send_cost_cents >= 0),
    currency             text        NOT NULL DEFAULT 'USD',
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER segment_pnl_cost_config_set_updated_at
    BEFORE UPDATE ON segment_pnl_cost_config
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE ON segment_pnl_cost_config TO postwave_app;

ALTER TABLE segment_pnl_cost_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE segment_pnl_cost_config FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON segment_pnl_cost_config
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON segment_pnl_cost_config
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
