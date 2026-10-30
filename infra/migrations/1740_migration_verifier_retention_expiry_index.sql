-- Online index for the raw subscriber-verifier retention sweeper.
--
-- Keep this non-transactional operation separate from migration 1737's atomic
-- schema/data transaction. DROP + CREATE makes the version crash-retryable:
-- PostgreSQL can leave an invalid same-name index when CREATE INDEX
-- CONCURRENTLY is interrupted, and the migration runner records the version
-- only after every statement succeeds.
-- rollback-strategy: no-op - the index is additive and application-compatible;
-- leave it in place when rolling back application code.

DROP INDEX CONCURRENTLY IF EXISTS
    migration_verifier_subscriber_observations_expiry_idx;

CREATE INDEX CONCURRENTLY
    migration_verifier_subscriber_observations_expiry_idx
    ON migration_verifier_subscriber_observations (tenant_id, expires_at, job_id);
