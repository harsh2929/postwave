-- 1643_audience_sync_provider_evidence.sql
--
-- Preserve provider-side delivery evidence for native audience destinations.
-- Google Data Manager returns a requestId from audienceMembers:ingest; keeping
-- it on the run/job ledger lets operators correlate Postwave history with
-- provider diagnostics without storing raw credentials or payload rows.

BEGIN;

ALTER TABLE audience_sync_runs
    ADD COLUMN IF NOT EXISTS external_job_id text,
    ADD COLUMN IF NOT EXISTS external_audience_id text,
    ADD COLUMN IF NOT EXISTS provider_message text;

ALTER TABLE audience_sync_jobs
    ADD COLUMN IF NOT EXISTS external_job_id text,
    ADD COLUMN IF NOT EXISTS external_audience_id text,
    ADD COLUMN IF NOT EXISTS provider_message text;

COMMENT ON COLUMN audience_sync_runs.external_job_id IS
    'Provider-side run/job/request identifier, such as Google Data Manager audienceMembers:ingest requestId.';
COMMENT ON COLUMN audience_sync_jobs.external_job_id IS
    'Provider-side run/job/request identifier, such as Google Data Manager audienceMembers:ingest requestId.';

COMMIT;
