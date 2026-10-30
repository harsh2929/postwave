-- 0019_api_key_budgets.sql
--
-- Per-API-key budgets (sends/day, dollars/month) and a usage counter table
-- the budgets middleware updates atomically. Adds an `actor_type` column to
-- api_keys so the audit + cost subsystems can distinguish human vs agent
-- callers without a separate join.

BEGIN;

ALTER TABLE api_keys
    ADD COLUMN sends_per_day           int,
    ADD COLUMN dollars_per_month_cents int,
    ADD COLUMN actor_label             text,
    ADD COLUMN actor_type              text NOT NULL DEFAULT 'human'
        CHECK (actor_type IN ('human', 'agent'));

CREATE TABLE api_key_usage (
    api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    tenant_id  uuid NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
    period     date NOT NULL,
    sends      int  NOT NULL DEFAULT 0,
    cost_cents int  NOT NULL DEFAULT 0,
    PRIMARY KEY (api_key_id, period)
);

CREATE INDEX api_key_usage_tenant_period_idx
    ON api_key_usage (tenant_id, period DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON api_key_usage TO postwave_app;

ALTER TABLE api_key_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_usage FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON api_key_usage
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
