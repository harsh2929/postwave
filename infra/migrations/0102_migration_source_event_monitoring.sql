-- 0102_migration_source_event_monitoring.sql
--
-- Event-level source monitoring for customer cutover windows. Unlike the
-- count-only shadow monitor, this stores individual source mutations and
-- whether Postwave replayed the canonical projection.

BEGIN;

CREATE TABLE IF NOT EXISTS migration_source_event_monitors (
    job_id             uuid PRIMARY KEY REFERENCES migration_jobs(id) ON DELETE CASCADE,
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source             text NOT NULL,
    enabled            boolean NOT NULL DEFAULT true,
    interval_seconds   integer NOT NULL DEFAULT 300 CHECK (interval_seconds BETWEEN 60 AND 86400),
    cursor             text NOT NULL DEFAULT '',
    last_event_at      timestamptz,
    last_synced_at     timestamptz,
    next_sync_at       timestamptz,
    last_error         text,
    events_seen        integer NOT NULL DEFAULT 0,
    events_applied     integer NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS migration_source_event_monitors_due_idx
    ON migration_source_event_monitors (enabled, next_sync_at)
    WHERE enabled = true;

CREATE TABLE IF NOT EXISTS migration_source_event_results (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id           uuid NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source           text NOT NULL,
    source_event_id  text NOT NULL,
    resource_type    text NOT NULL,
    action           text NOT NULL,
    occurred_at      timestamptz,
    applied          boolean NOT NULL DEFAULT false,
    error            text,
    payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, job_id, source_event_id)
);

CREATE INDEX IF NOT EXISTS migration_source_event_results_job_idx
    ON migration_source_event_results (tenant_id, job_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON migration_source_event_monitors TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON migration_source_event_results TO postwave_app;

ALTER TABLE migration_source_event_monitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_source_event_monitors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration_source_event_monitors;
CREATE POLICY tenant_isolation ON migration_source_event_monitors
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE migration_source_event_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_source_event_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration_source_event_results;
CREATE POLICY tenant_isolation ON migration_source_event_results
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
