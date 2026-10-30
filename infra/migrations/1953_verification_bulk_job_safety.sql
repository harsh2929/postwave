-- 1953_verification_bulk_job_safety.sql
--
-- Durable, multi-replica ownership for billable email-verification jobs.
-- A provider call cannot be made until its exact item rows have a durable
-- lease and request_started_at receipt. If that receipt survives a worker
-- lease, the outcome is treated as ambiguous and is never retried
-- automatically: avoiding a duplicate vendor charge is more important than
-- pretending an uncertain batch completed.
--
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Additive columns/policies/indexes. Rollback may drop the
-- new columns only after every verification worker has reverted and no live
-- job uses leases; doing so discards ambiguity and idempotency evidence.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE verification_jobs
    ADD COLUMN IF NOT EXISTS idempotency_key text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS request_fingerprint text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS failure_code text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS ambiguous integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS lease_owner text,
    ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

ALTER TABLE verification_jobs
    DROP CONSTRAINT IF EXISTS verification_jobs_idempotency_key_check,
    ADD CONSTRAINT verification_jobs_idempotency_key_check
        CHECK (idempotency_key = '' OR octet_length(idempotency_key) BETWEEN 1 AND 255),
    DROP CONSTRAINT IF EXISTS verification_jobs_request_fingerprint_check,
    ADD CONSTRAINT verification_jobs_request_fingerprint_check
        CHECK (request_fingerprint = '' OR request_fingerprint ~ '^[0-9a-f]{64}$'),
    DROP CONSTRAINT IF EXISTS verification_jobs_safety_counts_check,
    ADD CONSTRAINT verification_jobs_safety_counts_check
        CHECK (ambiguous >= 0 AND attempts >= 0),
    DROP CONSTRAINT IF EXISTS verification_jobs_lease_shape_check,
    ADD CONSTRAINT verification_jobs_lease_shape_check CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL)
        OR (lease_owner IS NOT NULL AND lease_owner <> '' AND lease_expires_at IS NOT NULL)
    );

CREATE UNIQUE INDEX IF NOT EXISTS verification_jobs_idempotency_idx
    ON verification_jobs (tenant_id, idempotency_key)
    WHERE idempotency_key <> '';

DROP INDEX IF EXISTS verification_jobs_claimable_idx;
CREATE INDEX verification_jobs_claimable_idx
    ON verification_jobs (next_attempt_at, created_at, id)
    WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS verification_jobs_expired_lease_idx
    ON verification_jobs (lease_expires_at)
    WHERE status = 'running' AND lease_expires_at IS NOT NULL;

ALTER TABLE verification_job_items
    ADD COLUMN IF NOT EXISTS attempt_state text NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS attempt_token uuid,
    ADD COLUMN IF NOT EXISTS request_started_at timestamptz,
    ADD COLUMN IF NOT EXISTS lease_owner text,
    ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS completed_at timestamptz;

UPDATE verification_job_items
   SET attempt_state = CASE WHEN processed THEN 'succeeded' ELSE 'pending' END,
       attempt_token = CASE WHEN processed THEN COALESCE(attempt_token, gen_random_uuid()) ELSE NULL END,
       completed_at = CASE WHEN processed THEN COALESCE(checked_at, now()) ELSE NULL END
 WHERE attempt_state = 'pending';

ALTER TABLE verification_job_items
    DROP CONSTRAINT IF EXISTS verification_job_items_attempt_state_check,
    ADD CONSTRAINT verification_job_items_attempt_state_check
        CHECK (attempt_state IN ('pending', 'leased', 'succeeded', 'ambiguous')),
    DROP CONSTRAINT IF EXISTS verification_job_items_attempt_shape_check,
    ADD CONSTRAINT verification_job_items_attempt_shape_check CHECK (
        (attempt_state = 'pending'
            AND processed = false
            AND attempt_token IS NULL
            AND request_started_at IS NULL
            AND lease_owner IS NULL
            AND lease_expires_at IS NULL
            AND completed_at IS NULL)
        OR
        (attempt_state = 'leased'
            AND processed = false
            AND attempt_token IS NOT NULL
            AND lease_owner IS NOT NULL
            AND lease_owner <> ''
            AND lease_expires_at IS NOT NULL
            AND completed_at IS NULL)
        OR
        (attempt_state = 'succeeded'
            AND processed = true
            AND attempt_token IS NOT NULL
            AND lease_owner IS NULL
            AND lease_expires_at IS NULL
            AND completed_at IS NOT NULL)
        OR
        (attempt_state = 'ambiguous'
            AND processed = false
            AND attempt_token IS NOT NULL
            AND request_started_at IS NOT NULL
            AND lease_owner IS NULL
            AND lease_expires_at IS NULL
            AND completed_at IS NOT NULL)
    );

DROP INDEX IF EXISTS verification_job_items_pending_idx;
CREATE INDEX verification_job_items_pending_idx
    ON verification_job_items (job_id, id)
    WHERE attempt_state = 'pending';

CREATE INDEX IF NOT EXISTS verification_job_items_expired_lease_idx
    ON verification_job_items (job_id, lease_expires_at)
    WHERE attempt_state = 'leased';

-- Cross-tenant discovery has a deliberately narrow worker-only window. Every
-- item mutation is subsequently tenant-bound with db.WithTenantWorker.
DROP POLICY IF EXISTS verification_jobs_worker_select ON verification_jobs;
CREATE POLICY verification_jobs_worker_select ON verification_jobs
    FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

DROP POLICY IF EXISTS verification_jobs_worker_update ON verification_jobs;
CREATE POLICY verification_jobs_worker_update ON verification_jobs
    FOR UPDATE TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

-- Cache expiry is cross-tenant maintenance. Without this narrow worker
-- policy, FORCE RLS turns the hourly purge into a silent no-op whenever no
-- tenant GUC is set.
DROP POLICY IF EXISTS verification_cache_worker_select ON verification_cache;
CREATE POLICY verification_cache_worker_select ON verification_cache
    FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND expires_at <= now()
        AND (
            status NOT IN ('invalid', 'spamtrap', 'abuse', 'do_not_mail')
            OR checked_at <= now() - interval '365 days'
        )
    );

DROP POLICY IF EXISTS verification_cache_worker_delete ON verification_cache;
CREATE POLICY verification_cache_worker_delete ON verification_cache
    FOR DELETE TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND expires_at <= now()
        AND (
            status NOT IN ('invalid', 'spamtrap', 'abuse', 'do_not_mail')
            OR checked_at <= now() - interval '365 days'
        )
    );

-- Address-level job receipts share the same bounded retention window. Job
-- aggregates remain for billing/audit, while the PII-bearing item rows can be
-- deleted only after the parent is durably terminal and older than one year.
DROP POLICY IF EXISTS verification_job_items_worker_retention_select ON verification_job_items;
CREATE POLICY verification_job_items_worker_retention_select ON verification_job_items
    FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND EXISTS (
            SELECT 1 FROM verification_jobs AS job
             WHERE job.tenant_id = verification_job_items.tenant_id
               AND job.id = verification_job_items.job_id
               AND job.status IN ('completed', 'failed', 'canceled')
               AND job.completed_at <= now() - interval '365 days'
        )
    );

DROP POLICY IF EXISTS verification_job_items_worker_retention_delete ON verification_job_items;
CREATE POLICY verification_job_items_worker_retention_delete ON verification_job_items
    FOR DELETE TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND EXISTS (
            SELECT 1 FROM verification_jobs AS job
             WHERE job.tenant_id = verification_job_items.tenant_id
               AND job.id = verification_job_items.job_id
               AND job.status IN ('completed', 'failed', 'canceled')
               AND job.completed_at <= now() - interval '365 days'
        )
    );

COMMIT;
