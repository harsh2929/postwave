-- 1607_zero_copy_triggers_keyset_index.sql
--
-- Keyset-pagination support for GET /api/v1/zero-copy-triggers.
--
-- The List endpoint (apps/api/internal/zerocopy_triggers) now pages on
-- (updated_at, id) with ORDER BY updated_at DESC, id DESC and an optional
-- status filter. The existing indexes on this table are tuned for the
-- worker fan-out (tenant_id, status, last_polled_at) and do not order by
-- updated_at, so the paged list would otherwise sort the full tenant
-- partition on every page.
--
-- This composite index matches the keyset's leading equality predicate
-- (tenant_id) followed by the ordering columns (updated_at DESC, id DESC),
-- letting the planner satisfy the ORDER BY + LIMIT with an index range
-- scan and seek straight to the cursor position.

BEGIN;

CREATE INDEX IF NOT EXISTS external_warehouse_triggers_tenant_updated_idx
    ON external_warehouse_triggers (tenant_id, updated_at DESC, id DESC);

COMMIT;
