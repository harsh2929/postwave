-- 0037_voice_ingest_jobs.sql
--
-- Pillar 3 (Voice) ingest job persistence. Closes the half-baked
-- POST /v1/voice/sources/{id}/ingest endpoint, which previously returned
-- a fresh job_id that pointed at nothing — there was no row to poll.
--
-- A job is the asynchronous record of one ingest run for a source. The
-- handler creates the row 'pending', flips to 'running' on dispatch, then
-- to 'succeeded' or 'failed' when the goroutine finishes. The polling
-- endpoint GET /v1/voice/sources/{source_id}/ingest/{job_id} reads it.
--
-- Per-tenant RLS: the source already RLS-cascades to the tenant; we tag
-- jobs with tenant_id directly so the polling handler can scope by it
-- without joining.

BEGIN;

CREATE TABLE voice_ingest_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source_id       uuid NOT NULL REFERENCES voice_sources(id) ON DELETE CASCADE,
    status          text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','running','succeeded','failed')),
    item_count      int NOT NULL DEFAULT 0,
    error_message   text,
    started_at      timestamptz,
    finished_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX voice_ingest_jobs_tenant_source_idx
    ON voice_ingest_jobs (tenant_id, source_id, created_at DESC);

CREATE TRIGGER voice_ingest_jobs_set_updated_at
    BEFORE UPDATE ON voice_ingest_jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON voice_ingest_jobs TO postwave_app;

ALTER TABLE voice_ingest_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_ingest_jobs FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON voice_ingest_jobs
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
