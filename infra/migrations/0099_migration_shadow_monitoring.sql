-- 0099_migration_shadow_monitoring.sql
--
-- Continuous, count-based shadow monitoring for customer migration pilots.
-- The worker stores immutable shadow-check snapshots and the next scheduled
-- check time; actual replay still happens through idempotent delta-import.

BEGIN;

CREATE TABLE IF NOT EXISTS migration_shadow_monitors (
    job_id                  uuid PRIMARY KEY REFERENCES migration_jobs(id) ON DELETE CASCADE,
    tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source                  text NOT NULL,
    enabled                 boolean NOT NULL DEFAULT true,
    interval_seconds        integer NOT NULL DEFAULT 3600 CHECK (interval_seconds BETWEEN 300 AND 604800),
    last_checked_at         timestamptz,
    next_check_at           timestamptz,
    last_recommended_action text,
    last_error              text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS migration_shadow_monitors_due_idx
    ON migration_shadow_monitors (enabled, next_check_at)
    WHERE enabled = true;

CREATE INDEX IF NOT EXISTS migration_shadow_monitors_tenant_idx
    ON migration_shadow_monitors (tenant_id, source, updated_at DESC);

CREATE TABLE IF NOT EXISTS migration_shadow_check_results (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id              uuid NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source              text NOT NULL,
    generated_at        timestamptz NOT NULL DEFAULT now(),
    needs_delta_import  boolean NOT NULL DEFAULT false,
    recommended_action  text,
    error               text,
    snapshot            jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS migration_shadow_check_results_job_idx
    ON migration_shadow_check_results (tenant_id, job_id, generated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON migration_shadow_monitors TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON migration_shadow_check_results TO postwave_app;

ALTER TABLE migration_shadow_monitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_shadow_monitors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration_shadow_monitors;
CREATE POLICY tenant_isolation ON migration_shadow_monitors
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE migration_shadow_check_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_shadow_check_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration_shadow_check_results;
CREATE POLICY tenant_isolation ON migration_shadow_check_results
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
