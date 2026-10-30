-- 0178_api_key_calls_cost.sql
--
-- Per-call cost tracking + per-tool daily quotas.
--
-- Why a column on api_key_calls instead of a separate cost ledger:
--   * We already write one row per call; cost is one int64 more
--     per row.
--   * The dashboard's stats endpoint can compute "spend in last 7d"
--     in the same aggregate as latency/success.
--   * Cost zero is the default — endpoints that don't cost anything
--     (subscribers_list) just leave the column at 0.
--
-- The quota table is per-tenant + per-tool: `voice_profile_build`
-- might be capped at 50/day per tenant; `subscribers_list` not at
-- all. NULL daily_limit = unlimited (the default).

BEGIN;

ALTER TABLE api_key_calls
    ADD COLUMN IF NOT EXISTS cost_micros bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS mcp_tool_quotas (
    tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tool_name    text        NOT NULL,
    daily_limit  int,
    -- Per-call cost estimate in micros (1e-6 USD). When set, the
    -- dashboard pre-multiplies for projection. Real cost lands on
    -- api_key_calls.cost_micros at recorder time when the handler
    -- knows.
    estimated_cost_micros bigint NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, tool_name)
);

ALTER TABLE mcp_tool_quotas ENABLE ROW LEVEL SECURITY;

CREATE POLICY mcp_tool_quotas_tenant_isolation
    ON mcp_tool_quotas
    FOR ALL
    USING (tenant_id::text = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_tool_quotas TO postwave_app;

COMMIT;
