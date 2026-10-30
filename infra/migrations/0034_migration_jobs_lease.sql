-- 0034_migration_jobs_lease.sql
--
-- Atomic-claim lease for migration_jobs.
--
-- Problem (Week 2-3 audit, finding #10): the API runs in multiple instances
-- behind a load balancer; on rolling restart, every instance's recovery
-- worker enumerates runnable jobs and starts running them. The handler's
-- in-process map (h.active in services/migration/internal/handlers) only
-- dedupes within ONE process. Multi-instance => duplicate Listmonk imports.
--
-- Fix: add a (lease_owner, lease_expires_at) pair plus a partial index that
-- backs the FOR UPDATE SKIP LOCKED claim. A worker boots with a fresh UUID
-- and claims jobs whose lease is unset or expired. Worker death is bounded
-- by the lease TTL; renew-while-alive keeps long-running jobs locked.

BEGIN;

ALTER TABLE migration_jobs
    ADD COLUMN lease_owner       uuid,
    ADD COLUMN lease_expires_at  timestamptz;

-- Partial index supporting the claim query.
--
-- Postgres rejects `WHERE ... < now()` in an index predicate because
-- now() is STABLE, not IMMUTABLE — the index would silently include
-- rows whose stored timestamp is < the call-time `now()`, which is a
-- moving target. Instead we index every leased row and let the planner
-- still benefit from a (started_at) ordering on the SELECT FOR UPDATE
-- SKIP LOCKED query — the WHERE clause's runtime `now()` comparison
-- happens at query time, post-index-scan.
--
-- The "is currently claimable" predicate stays in the application
-- query, not the index. Cheap enough: most rows are terminal (status
-- IN ('completed','failed','rolled_back')) and short-lived in the
-- "leased" window.
CREATE INDEX migration_jobs_lease_idx
    ON migration_jobs (started_at)
    WHERE lease_expires_at IS NOT NULL;

COMMENT ON COLUMN migration_jobs.lease_owner IS
    'UUID of the worker process that currently holds the job lease.';
COMMENT ON COLUMN migration_jobs.lease_expires_at IS
    'When the lease becomes claimable again. NULL means unleased.';

COMMIT;
