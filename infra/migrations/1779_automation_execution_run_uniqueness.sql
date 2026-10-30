-- 1779_automation_execution_run_uniqueness.sql
--
-- Migration 1705 made automation_executions run-scoped, but the original
-- migration 0011 unique index on (automation_id, subscriber_email) remained.
-- That legacy index still allowed only one lifetime row per subscriber and
-- caused the second 'always' or 'cooldown' enrollment to fail even though the
-- primary key and runtime now include run_id.
--
-- Build and validate the replacement before removing the legacy index so a
-- failed concurrent build cannot weaken the logical uniqueness contract.
-- CONCURRENTLY requires this migration to remain outside BEGIN/COMMIT.
--
-- rollback-strategy: no-op - keep the run-aware index when rolling application
-- code back. Recreating the legacy index can fail after legitimate second-run
-- rows exist and would reintroduce the production defect.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS automation_executions_run_lookup_idx
    ON automation_executions (tenant_id, automation_id, subscriber_email, run_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relname = 'automation_executions_run_lookup_idx'
           AND i.indisunique
           AND i.indisvalid
           AND pg_get_indexdef(i.indexrelid) LIKE
               '%(tenant_id, automation_id, subscriber_email, run_id)%'
    ) THEN
        RAISE EXCEPTION
            'automation_executions_run_lookup_idx is absent, invalid, or has the wrong key; DROP INDEX CONCURRENTLY IF EXISTS automation_executions_run_lookup_idx and retry';
    END IF;
END $$;

DROP INDEX CONCURRENTLY IF EXISTS automation_executions_lookup_idx;

COMMENT ON INDEX automation_executions_run_lookup_idx IS
    'One execution-state row per tenant, automation, subscriber, and enrollment run; permits always/cooldown re-enrollment while retaining retry idempotency within a run.';
