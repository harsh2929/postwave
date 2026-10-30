-- 0405_ai_regression_settings.sql
--
-- Per-tenant AI-regression settings. A DEDICATED table (one row per tenant)
-- rather than columns on the central tenants table: keeps RLS uniform with
-- the other harness tables and avoids churning a hot shared table.
--
-- hard_gate_enabled is OFF by default — the harness is advisory first,
-- mirroring the VoiceDriftBanner honest-fallback posture. A hard gate only
-- becomes eligible once the tenant has min_examples_for_gate golden
-- examples; below that it degrades to advisory automatically (the apps/api
-- gate logic enforces this; the column is the operator-set ceiling).
--
-- rollback-strategy: no-op - additive table; absence of a row means defaults.

BEGIN;

CREATE TABLE IF NOT EXISTS ai_regression_settings (
    tenant_id              uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    warn_threshold         float8  NOT NULL DEFAULT 60.0
        CHECK (warn_threshold >= 0 AND warn_threshold <= 100),
    hard_gate_enabled      boolean NOT NULL DEFAULT false,
    hard_gate_threshold    float8  NOT NULL DEFAULT 70.0
        CHECK (hard_gate_threshold >= 0 AND hard_gate_threshold <= 100),
    min_examples_for_gate  int     NOT NULL DEFAULT 5
        CHECK (min_examples_for_gate >= 1),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER ai_regression_settings_set_updated_at
    BEFORE UPDATE ON ai_regression_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE ON ai_regression_settings TO postwave_app;

ALTER TABLE ai_regression_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_regression_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ai_regression_settings
    AS PERMISSIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
