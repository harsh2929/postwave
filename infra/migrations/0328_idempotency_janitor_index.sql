-- 0328_idempotency_janitor_index.sql
--
-- Janitor index for the generalized Idempotency-Key middleware. The dedup
-- middleware (idempotency.Process) is now mounted on the entire authenticated
-- mutation surface, so the sweeper runs more often as the row count grows.
-- The existing idempotency_records_expires_idx from 0021 covers the same
-- column; we add a name-stable janitor index aligned with the v2 contract so
-- ops can monitor (and EXPLAIN against) a single canonical name. IF NOT EXISTS
-- keeps this safe on tenants that already have an equivalent index from the
-- legacy migration. RLS unchanged — the table is already tenant_id scoped via
-- the policy from 0021 (NULLIF(current_setting('app.tenant_id', true), '')::uuid)
-- plus the permissive idempotency_sweeper policy for the cross-tenant janitor.

BEGIN;

CREATE INDEX IF NOT EXISTS idempotency_records_expires_at_idx
    ON idempotency_records (expires_at)
    WHERE expires_at IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_records TO postwave_app;

COMMIT;
