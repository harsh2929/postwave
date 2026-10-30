-- 0168_recurrence_spawn_unique.sql
--
-- Closes the multi-replica recurrence-scanner race documented in the
-- worker audit:
--
--   The 24-hour recurrence scanner fires on both API replicas
--   simultaneously. Both call `spawn()` for the same parent
--   campaign, both INSERT a new child row with the same parent_id
--   + send_at, and the post-spawn `markLastRun` sets
--   recurrence_last_run only AFTER both INSERTs land — too late to
--   prevent the duplicate. Two children spawned per tick → two
--   actual sends per recurrence cycle.
--
-- Fix: partial unique index on (parent_campaign_id, send_at) where
-- parent is non-null. spawn() can wrap its INSERT in ON CONFLICT
-- DO NOTHING, making it idempotent: replica B's INSERT loses the
-- unique constraint race and is a no-op. The legitimate single-
-- replica case still inserts exactly once.
--
-- Partial index because child rows are a small subset of all
-- campaigns (only recurrence-spawned ones have parent_id set).
-- CONCURRENTLY so we can roll forward without locking the
-- campaigns table; runs outside BEGIN/COMMIT.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS campaigns_parent_send_at_uniq
    ON campaigns (parent_campaign_id, send_at)
    WHERE parent_campaign_id IS NOT NULL AND send_at IS NOT NULL;
