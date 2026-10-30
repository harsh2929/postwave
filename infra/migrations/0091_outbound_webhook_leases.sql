-- 0091_outbound_webhook_leases.sql
--
-- Job-lease columns for outbound_webhook_deliveries so multiple gateway
-- replicas can drain the pending queue without ever double-firing.
--
-- Today (0088 schema) the retry worker claims pending rows via
-- `FOR UPDATE SKIP LOCKED` and then atomically nulls next_attempt_at to
-- "hide" them from sibling workers. That's correct for the simple case
-- but the row is invisibly in-flight forever if the worker dies between
-- claim and final mark — the next sweep can't tell whether it's still
-- being processed or orphaned.
--
-- The lease pair fixes that:
--
--   - lease_owner       — hostname-pid identifier of the worker that
--                         currently holds the row. Free-form text
--                         (not uuid) so callers can choose whatever
--                         scheme survives container restarts.
--   - lease_expires_at  — when another worker may steal the row back.
--                         Set by AcquireLease to now() + leaseDuration.
--                         Cleared implicitly when the row finalises
--                         to status='delivered' or 'exhausted'.
--
-- Recovery flow when a worker is OOM-killed mid-delivery:
--
--   1. The row stays status='pending' (MarkSucceeded/MarkFailure never
--      ran).
--   2. lease_expires_at is in the past once leaseDuration elapses.
--   3. The next AcquireLease sweep treats it as eligible (its WHERE
--      clause matches `lease_expires_at IS NULL OR lease_expires_at <
--      now()`) and a different worker takes it over.
--
-- Migration is idempotent: `ADD COLUMN IF NOT EXISTS` so rollouts can
-- run safely against partially-migrated databases.

BEGIN;

ALTER TABLE outbound_webhook_deliveries
    ADD COLUMN IF NOT EXISTS lease_owner       text,
    ADD COLUMN IF NOT EXISTS lease_expires_at  timestamptz;

-- Partial index supporting the lease-eligibility check on the hot path.
--
-- Postgres rejects `WHERE ... < now()` in an index predicate because
-- now() is STABLE not IMMUTABLE; instead we index every leased row and
-- the planner still narrows the scan via lease_expires_at ordering.
-- The "currently claimable" filter stays in the application query.
CREATE INDEX IF NOT EXISTS idx_owd_lease_active
    ON outbound_webhook_deliveries (lease_expires_at)
    WHERE status = 'pending' AND lease_owner IS NOT NULL;

COMMENT ON COLUMN outbound_webhook_deliveries.lease_owner IS
    'Identifier of the worker process that holds the row lease (hostname-pid). NULL = unleased.';
COMMENT ON COLUMN outbound_webhook_deliveries.lease_expires_at IS
    'When the lease expires. NULL = unleased. A worker that crashes mid-delivery leaves the row leased until this passes, then another worker can pick it up.';

COMMIT;
