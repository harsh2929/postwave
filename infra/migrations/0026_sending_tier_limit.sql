-- 0026_sending_tier_limit.sql
--
-- Persist the per-tenant post-warmup send ceiling used by the warmup tracker.
-- Without this, the Postgres tracker can reconstruct daily counters after a
-- restart but loses the tier's terminal cap once the 30-day schedule ends.

BEGIN;

ALTER TABLE sending_state
    ADD COLUMN IF NOT EXISTS tier_limit int NOT NULL DEFAULT 0;

COMMIT;
