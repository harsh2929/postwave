-- 1956_subscriber_import_verification_enforcement.sql
--
-- Freeze subscriber-import verification policy at the reviewed confirmation
-- boundary and bind execution to one durable verification job.  The import
-- worker never performs a metered provider request inline: it waits for the
-- verification job's durable item receipts before any subscriber/consent
-- mutation can begin.
--
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Additive columns plus one nullable composite foreign key.
-- Revert application workers before dropping these columns; dropping them
-- discards the audit link between an import and its verification decisions.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE verification_jobs
    ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'full',
    ADD COLUMN IF NOT EXISTS execution_class text NOT NULL DEFAULT 'bulk',
    ADD COLUMN IF NOT EXISTS activated_at timestamptz;

ALTER TABLE verification_jobs
    DROP CONSTRAINT IF EXISTS verification_jobs_execution_mode_check,
    ADD CONSTRAINT verification_jobs_execution_mode_check
        CHECK (execution_mode IN ('local', 'full')),
    DROP CONSTRAINT IF EXISTS verification_jobs_execution_class_check,
    ADD CONSTRAINT verification_jobs_execution_class_check
        CHECK (execution_class IN ('bulk', 'subscriber_import')),
    DROP CONSTRAINT IF EXISTS verification_jobs_status_check,
    ADD CONSTRAINT verification_jobs_status_check CHECK (
        (execution_class = 'bulk'
            AND status IN ('pending', 'running', 'completed', 'failed', 'canceled'))
        OR
        (execution_class = 'subscriber_import'
            -- These private lifecycle states are intentionally invisible to
            -- pre-1956 workers. During a rolling deploy, an old worker cannot
            -- claim an import job and accidentally spend in local mode.
            AND status IN ('import_pending', 'import_running', 'completed', 'failed', 'canceled'))
    ),
    DROP CONSTRAINT IF EXISTS verification_jobs_import_execution_shape_check,
    ADD CONSTRAINT verification_jobs_import_execution_shape_check CHECK (
        execution_class <> 'subscriber_import'
        OR (source = 'upload' AND (
            (status IN ('import_pending', 'import_running')
                AND source_ref <> '' AND idempotency_key <> '')
            OR status IN ('completed', 'failed', 'canceled')
        ))
    );

DROP INDEX IF EXISTS verification_jobs_claimable_idx;
CREATE INDEX verification_jobs_claimable_idx
    ON verification_jobs (next_attempt_at, created_at, id)
    WHERE status IN ('pending', 'running', 'import_pending', 'import_running');

DROP INDEX IF EXISTS verification_jobs_expired_lease_idx;
CREATE INDEX verification_jobs_expired_lease_idx
    ON verification_jobs (lease_expires_at)
    WHERE status IN ('running', 'import_running') AND lease_expires_at IS NOT NULL;

-- Internal import jobs and user-created bulk jobs have disjoint idempotency
-- namespaces. A tenant user can reuse the visible import-derived key only for
-- a bulk job; it cannot occupy or conflict with the trusted import binding.
DROP INDEX IF EXISTS verification_jobs_idempotency_idx;
CREATE UNIQUE INDEX verification_jobs_idempotency_idx
    ON verification_jobs (tenant_id, execution_class, idempotency_key)
    WHERE idempotency_key <> '';

ALTER TABLE subscriber_imports
    DROP CONSTRAINT IF EXISTS subscriber_imports_status_check,
    ADD CONSTRAINT subscriber_imports_status_check
        CHECK (status IN (
            'preview', 'queued', 'running',
            'verification_queued', 'verification_running',
            'ready', 'failed', 'cancelled'
        )),
    ADD COLUMN IF NOT EXISTS preflight_verification_mode text NOT NULL DEFAULT 'off',
    ADD COLUMN IF NOT EXISTS verification_mode text NOT NULL DEFAULT 'off',
    ADD COLUMN IF NOT EXISTS verification_state text NOT NULL DEFAULT 'off',
    ADD COLUMN IF NOT EXISTS verification_job_id uuid,
    ADD COLUMN IF NOT EXISTS verification_completed_at timestamptz,
    ADD COLUMN IF NOT EXISTS rows_verification_rejected bigint NOT NULL DEFAULT 0;

ALTER TABLE subscriber_imports
    DROP CONSTRAINT IF EXISTS subscriber_imports_preflight_verification_mode_check,
    ADD CONSTRAINT subscriber_imports_preflight_verification_mode_check
        CHECK (preflight_verification_mode IN ('off', 'local', 'full')),
    DROP CONSTRAINT IF EXISTS subscriber_imports_verification_mode_check,
    ADD CONSTRAINT subscriber_imports_verification_mode_check
        CHECK (verification_mode IN ('off', 'local', 'full')),
    DROP CONSTRAINT IF EXISTS subscriber_imports_verification_state_check,
    ADD CONSTRAINT subscriber_imports_verification_state_check
        CHECK (verification_state IN ('off', 'pending', 'running', 'completed', 'failed')),
    DROP CONSTRAINT IF EXISTS subscriber_imports_verification_rollout_check,
    ADD CONSTRAINT subscriber_imports_verification_rollout_check CHECK (
        (verification_mode = 'off'
            AND status NOT IN ('verification_queued', 'verification_running'))
        OR
        (verification_mode IN ('local', 'full')
            -- Private states keep configured imports away from pre-1956
            -- workers for their entire non-terminal lifetime. This prevents a
            -- rolling-deploy worker from importing rows without enforcement.
            AND status NOT IN ('preview', 'queued', 'running'))
    ),
    DROP CONSTRAINT IF EXISTS subscriber_imports_verification_write_fence_check,
    ADD CONSTRAINT subscriber_imports_verification_write_fence_check CHECK (
        verification_mode = 'off'
        OR processed_rows = 0
        OR verification_state = 'completed'
    ),
    DROP CONSTRAINT IF EXISTS subscriber_imports_verification_ready_fence_check,
    ADD CONSTRAINT subscriber_imports_verification_ready_fence_check CHECK (
        status <> 'ready'
        OR verification_mode = 'off'
        OR verification_state = 'completed'
    ),
    DROP CONSTRAINT IF EXISTS subscriber_imports_verification_shape_check,
    ADD CONSTRAINT subscriber_imports_verification_shape_check CHECK (
        (verification_mode = 'off'
            AND verification_state = 'off'
            AND verification_job_id IS NULL
            AND verification_completed_at IS NULL)
        OR
        (verification_mode IN ('local', 'full')
            AND verification_state = 'pending'
            AND verification_completed_at IS NULL)
        OR
        (verification_mode IN ('local', 'full')
            AND verification_state = 'running'
            AND verification_job_id IS NOT NULL
            AND verification_completed_at IS NULL)
        OR
        (verification_mode IN ('local', 'full')
            AND verification_state = 'completed'
            AND verification_job_id IS NOT NULL
            AND verification_completed_at IS NOT NULL)
        OR
        (verification_mode IN ('local', 'full')
            AND verification_state = 'failed'
            AND verification_completed_at IS NOT NULL)
    ),
    DROP CONSTRAINT IF EXISTS subscriber_imports_verification_job_fkey,
    ADD CONSTRAINT subscriber_imports_verification_job_fkey
        FOREIGN KEY (tenant_id, verification_job_id)
        REFERENCES verification_jobs (tenant_id, id)
        ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS subscriber_imports_verification_job_idx
    ON subscriber_imports (tenant_id, verification_job_id)
    WHERE verification_job_id IS NOT NULL;

-- Reject preview→queued transitions from an old API replica whenever the
-- tenant policy requires verification. New replicas use verification_queued
-- and freeze the exact mode on the import row.
CREATE OR REPLACE FUNCTION enforce_subscriber_import_verification_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
    policy_mode text;
BEGIN
    IF OLD.status = 'preview' AND NEW.status IN ('queued', 'verification_queued') THEN
        SELECT vp.import_mode INTO policy_mode
          FROM verification_policy AS vp
         WHERE vp.tenant_id = NEW.tenant_id;
        policy_mode := COALESCE(policy_mode, 'off');
        IF NEW.verification_mode IS DISTINCT FROM policy_mode THEN
            RAISE EXCEPTION 'subscriber import verification policy changed during confirmation'
                USING ERRCODE = '40001';
        END IF;
		IF policy_mode = 'off' AND NEW.status <> 'queued' THEN
			RAISE EXCEPTION 'subscriber import verification transition does not match policy'
				USING ERRCODE = '40001';
		END IF;
		IF policy_mode <> 'off' AND NEW.status <> 'verification_queued' THEN
			RAISE EXCEPTION 'subscriber import verification enforcement requires a current API replica'
				USING ERRCODE = '40001';
		END IF;
    END IF;
    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS subscriber_imports_verification_transition_guard ON subscriber_imports;
CREATE TRIGGER subscriber_imports_verification_transition_guard
BEFORE UPDATE ON subscriber_imports
FOR EACH ROW
EXECUTE FUNCTION enforce_subscriber_import_verification_transition();

COMMIT;
