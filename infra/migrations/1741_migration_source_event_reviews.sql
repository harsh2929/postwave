-- 1741_migration_source_event_reviews.sql
--
-- Keep automatic replay outcome separate from the operator review state for
-- source events that are intentionally preserved for manual reconciliation.

BEGIN;

ALTER TABLE migration_source_event_results
    ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS review_detail text,
    ADD COLUMN IF NOT EXISTS review_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

ALTER TABLE migration_source_event_results
    DROP CONSTRAINT IF EXISTS migration_source_event_results_review_status_check;
ALTER TABLE migration_source_event_results
    ADD CONSTRAINT migration_source_event_results_review_status_check
    CHECK (review_status IN ('pending', 'reviewed'));

ALTER TABLE migration_source_event_results
    DROP CONSTRAINT IF EXISTS migration_source_event_results_review_evidence_check;
ALTER TABLE migration_source_event_results
    ADD CONSTRAINT migration_source_event_results_review_evidence_check
    CHECK (jsonb_typeof(review_evidence) = 'array');

COMMIT;

-- migration_source_event_results is an existing, write-active replay ledger.
-- Build the review queue index after the additive schema transaction and with
-- CONCURRENTLY so monitor writes remain available during rollout. DROP +
-- CREATE is intentional: PostgreSQL can leave an invalid same-name index when
-- a concurrent build is interrupted, and IF NOT EXISTS would then make a retry
-- falsely succeed. The migration runner records 1741 only after both phases
-- finish; independent migration 1742 therefore cannot run ahead of this one.
DROP INDEX CONCURRENTLY IF EXISTS
    migration_source_event_results_pending_review_idx;

CREATE INDEX CONCURRENTLY
    migration_source_event_results_pending_review_idx
    ON migration_source_event_results (tenant_id, job_id, created_at DESC)
    WHERE applied = false
      AND action = 'manual_review'
      AND review_status = 'pending';
