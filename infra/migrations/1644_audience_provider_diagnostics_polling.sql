-- 1644_audience_provider_diagnostics_polling.sql
--
-- Roll up provider-side async status for native audience deliveries. Google
-- Data Manager accepts Customer Match uploads asynchronously and returns a
-- requestId; these fields let the background poller record request status and
-- backoff cadence without storing raw credentials or audience-member payloads.

BEGIN;

ALTER TABLE audience_sync_runs
    ADD COLUMN IF NOT EXISTS provider_status text,
    ADD COLUMN IF NOT EXISTS provider_checked_at timestamptz,
    ADD COLUMN IF NOT EXISTS provider_next_check_at timestamptz,
    ADD COLUMN IF NOT EXISTS provider_poll_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE audience_sync_jobs
    ADD COLUMN IF NOT EXISTS provider_status text,
    ADD COLUMN IF NOT EXISTS provider_checked_at timestamptz,
    ADD COLUMN IF NOT EXISTS provider_next_check_at timestamptz,
    ADD COLUMN IF NOT EXISTS provider_poll_attempts integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS audience_sync_runs_provider_poll_due_idx
    ON audience_sync_runs (provider_next_check_at, provider_poll_attempts)
    WHERE external_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audience_sync_jobs_provider_poll_due_idx
    ON audience_sync_jobs (provider_next_check_at, provider_poll_attempts)
    WHERE external_job_id IS NOT NULL;

COMMENT ON COLUMN audience_sync_runs.provider_status IS
    'Provider-side async result status for external_job_id, for example Google Data Manager requestStatus.';
COMMENT ON COLUMN audience_sync_jobs.provider_status IS
    'Provider-side async result status for external_job_id, for example Google Data Manager requestStatus.';
COMMENT ON COLUMN audience_sync_runs.provider_next_check_at IS
    'Next background diagnostics poll time for provider async status.';
COMMENT ON COLUMN audience_sync_jobs.provider_next_check_at IS
    'Next background diagnostics poll time for provider async status.';

-- audience_destinations and audience_sync_jobs were created with restrictive
-- tenant RLS. The diagnostics poller needs cross-tenant SELECT only, then it
-- re-enters tenant scope for per-row writes.
DROP POLICY IF EXISTS tenant_isolation ON audience_destinations;
CREATE POLICY tenant_isolation ON audience_destinations
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
    );

DROP POLICY IF EXISTS tenant_isolation ON audience_sync_jobs;
CREATE POLICY tenant_isolation ON audience_sync_jobs
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
    );

DROP POLICY IF EXISTS audience_destinations_worker_select ON audience_destinations;
CREATE POLICY audience_destinations_worker_select ON audience_destinations
    AS PERMISSIVE FOR SELECT
    TO postwave_app
    USING (COALESCE(current_setting('app.outbox_worker', true), '') = 'true');

DROP POLICY IF EXISTS audience_sync_jobs_worker_select ON audience_sync_jobs;
CREATE POLICY audience_sync_jobs_worker_select ON audience_sync_jobs
    AS PERMISSIVE FOR SELECT
    TO postwave_app
    USING (COALESCE(current_setting('app.outbox_worker', true), '') = 'true');

DROP POLICY IF EXISTS audience_sync_runs_worker_select ON audience_sync_runs;
CREATE POLICY audience_sync_runs_worker_select ON audience_sync_runs
    AS PERMISSIVE FOR SELECT
    TO postwave_app
    USING (COALESCE(current_setting('app.outbox_worker', true), '') = 'true');

COMMIT;
