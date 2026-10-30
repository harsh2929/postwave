-- 0352_partition_rotator_enable.sql
--
-- Phase 4 `p4a-mig-0352-partition-enable` (critical, effort=S).
--
-- Flip every row in partition_rotator_config from enabled=false to
-- enabled=true so the partition rotator worker actually runs in
-- production. Without this, the worker introduced by 0339 will sit
-- idle, the pre-created month partitions (current + next 2) will not
-- be extended, and INSERTs into any of the five partitioned event
-- tables will start failing with
--
--     ERROR: no partition of relation "<table>" found for row
--     DETAIL: Partition key of the failing row contains (at) = (...)
--
-- the first time `at` lands beyond the last pre-created child. With
-- the 0339-seeded 3-month window (current + 2 ahead), production
-- starts dropping writes ~90 days after 0339 ships unless the rotator
-- pre-creates the next month before the boundary.
--
-- Why this is a separate migration and not folded into 0339:
--   0339 was deliberately shipped with `enabled=false` so an operator
--   could verify the rotator's behavior on a staging environment
--   (nightly DETACH boundary, hard DROP ceiling, immutability-trigger
--   re-attach, etc.) before letting it touch production. The Phase 4
--   plan is to enable rotation everywhere now that the worker has
--   been observed quiescent on staging for one full month-rollover
--   cycle. Keeping the enable as its own migration also makes the
--   "rollback by setting enabled=false" knob crisp — operators can
--   reverse this single migration without touching 0339's schema.
--
-- See infra/migrations/0339_partition_event_tables.sql section 6 for
-- the partition_rotator_config table definition and the per-table
-- retention defaults.
--
-- Rollback:
--   To disable the rotator without dropping the config rows, run:
--
--     UPDATE partition_rotator_config SET enabled = false;
--
--   This is a metadata-only flip; the worker checks `enabled` on
--   every tick and goes quiescent within a single tick (default 5m).

BEGIN;

UPDATE partition_rotator_config
   SET enabled    = true,
       updated_at = now()
 WHERE enabled    = false;

COMMIT;
