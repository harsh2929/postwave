-- 0004_migration_jobs.sql
--
-- Tracks long-running tenant migrations from third-party platforms
-- (Mailchimp, ConvertKit, Beehiiv, etc.) into Postwave. Schema mirrors the
-- canonical `MigrationJob` shape declared in
-- packages/schema/src/index.ts so the API contract stays in lock-step with
-- the TypeScript clients.

BEGIN;

CREATE TABLE migration_jobs (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source                text NOT NULL,                                  -- e.g. 'mailchimp', 'convertkit'
    status                text NOT NULL,                                  -- e.g. 'queued', 'running', 'verifying', 'complete', 'failed', 'rolled_back'
    progress              jsonb NOT NULL DEFAULT '{}'::jsonb,
    cursor                jsonb NOT NULL DEFAULT '{}'::jsonb,             -- resumable pagination state
    verification_report   jsonb,
    started_at            timestamptz NOT NULL DEFAULT now(),
    completed_at          timestamptz,
    rollback_until        timestamptz,                                    -- safety window to undo
    error                 text
);

CREATE INDEX migration_jobs_tenant_status_started_idx
    ON migration_jobs (tenant_id, status, started_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON migration_jobs TO postwave_app;

ALTER TABLE migration_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_jobs FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON migration_jobs
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
