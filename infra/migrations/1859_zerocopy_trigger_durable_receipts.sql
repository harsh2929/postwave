-- 1859_zerocopy_trigger_durable_receipts.sql
--
-- Durable execution receipts for zero-copy warehouse triggers.
--
-- WHAT THIS IS NOT: this does not fix a duplicate-send incident. The zero-copy
-- subsystem has never executed. Four independent gates stop it — the runtime
-- gate, a worker main.go never starts (and a contract test forbidding it), a
-- "Poll now" handler that returns 503 unconditionally, and `flowbuilder`'s own
-- closed gate, which means no `flow_runs` row can be created at all. An earlier
-- draft of this header claimed otherwise.
--
-- WHAT IT IS: the poll loop's exactly-once story was unsound, and the receipt
-- is the precondition for it being sound before the gate is ever opened.
-- `external_warehouse_trigger_fires` was already one row per (trigger,
-- warehouse row); it simply had no uniqueness, so it recorded what happened
-- without being able to stop it happening twice.
--
--   1. `claimed` and `enqueueing` become legal statuses. The distinction is
--      load-bearing: a row still `claimed` provably never reached EnqueueRun,
--      so it is safe to recover. A row in `enqueueing` MAY have — and since
--      `flow_runs` has no idempotency key, nothing downstream can tell. That
--      row is terminated with a marker, logged, and exposed through
--      `GET /api/v1/zero-copy-triggers/indeterminate`; it is NOT sent to the
--      DLQ, because `ReconcileDLQ` replays pending entries through EnqueueRun,
--      which is precisely the retry that must not happen. Collapsing the two
--      statuses forces a guess between duplicate enrolment and lost enrolment.
--   2. (tenant_id, trigger_id, cursor_value, profile_key) becomes unique, so a
--      claim is an INSERT ... ON CONFLICT and two replicas polling one trigger
--      cannot both win the same row.
--
-- The key columns are HASHED in the index. `cursor_value` and `profile_key`
-- come straight from a customer's warehouse into unbounded `text`, and btree
-- caps an index tuple at 2704 bytes: a wide column would abort this migration
-- on an existing row, and abort the claim on a new one. md5 is used because it
-- is core (no pgcrypto dependency) and this is a uniqueness key, not a security
-- boundary — the threat is an oversized cell, not an adversary choosing one.
-- Repo.ClaimFire compares the raw values as well, so a collision costs an index
-- probe rather than merging two distinct rows.
--
-- NOTE ON DUPLICATES: an earlier draft deduplicated the table in-migration with
-- a DELETE. Two things were wrong with that. The repo's migration linter
-- classifies `DELETE FROM` as a SafetyBlocker — `cmd/migrate` exits 5 without
-- `--allow-unsafe`, so the migration could not have been deployed by a routine
-- release at all. And its own rule ("keep the row with a flow_run_id") silently
-- destroyed ledger rows that link a warehouse row to the run it produced. This
-- version REFUSES instead: it names the conflict and stops, leaving cleanup to
-- an audited job, which is what the safety rule prescribes.

BEGIN;

DO $$
DECLARE
    dupes bigint;
BEGIN
    SELECT count(*) INTO dupes
      FROM (
        SELECT 1
          FROM external_warehouse_trigger_fires
         GROUP BY tenant_id, trigger_id, md5(cursor_value), md5(profile_key)
        HAVING count(*) > 1
      ) d;
    IF dupes > 0 THEN
        RAISE EXCEPTION
            'external_warehouse_trigger_fires has % duplicate (tenant, trigger, cursor, profile) group(s); '
            'migration 1859 cannot add its uniqueness constraint over them. These rows are the ledger '
            'linking warehouse rows to the runs they produced, so this migration will not delete them. '
            'Reconcile them with an audited job first.', dupes;
    END IF;
END $$;

-- NOT VALID first: adding a validated CHECK takes ACCESS EXCLUSIVE and full-
-- scans the table, which on a populated table is a read AND write outage for
-- the length of this migration. NOT VALID takes the lock only briefly; the
-- separate VALIDATE below takes a weaker lock and can run long.
ALTER TABLE external_warehouse_trigger_fires
    DROP CONSTRAINT IF EXISTS external_warehouse_trigger_fires_status_check;

ALTER TABLE external_warehouse_trigger_fires
    ADD CONSTRAINT external_warehouse_trigger_fires_status_check
    CHECK (status IN ('claimed', 'enqueueing', 'fired', 'matched_no_subscriber', 'skipped_log_only', 'error'))
    NOT VALID;

COMMIT;

ALTER TABLE external_warehouse_trigger_fires
    VALIDATE CONSTRAINT external_warehouse_trigger_fires_status_check;

-- CONCURRENTLY, and therefore outside any transaction: a plain CREATE INDEX
-- holds a write lock for the whole build. The table is empty today because the
-- subsystem has never run, but a migration cannot know that about a customer's
-- database.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS external_warehouse_trigger_fires_receipt_idx
    ON external_warehouse_trigger_fires
       (tenant_id, trigger_id, md5(cursor_value), md5(profile_key));

-- Recovery scans by (status, fired_at): stale `claimed` rows are re-claimable,
-- stale `enqueueing` rows are escalated. Without this the sweep is a full scan
-- of every receipt ever written.
CREATE INDEX CONCURRENTLY IF NOT EXISTS external_warehouse_trigger_fires_pending_idx
    ON external_warehouse_trigger_fires (fired_at)
    WHERE status IN ('claimed', 'enqueueing');
