-- 1886_web_push_retry_schedule.sql
--
-- The half of migration 1883 that was missing.
--
-- 1883 gave web push a delivery record and its own comment said the ledger
-- "makes a failure visible and re-sendable" while a retry worker was "separate
-- work". Building the worker exposed that re-sendable was not yet true: the
-- table recorded the OUTCOME and not when to try again, so nothing could pick a
-- row up without re-deriving a schedule from `updated_at` at every call site.
--
-- `mobile_push_deliveries` has `next_retry_at` for exactly this reason, and the
-- row that asked for these ledgers asked for its semantics. An explicit column
-- is also what makes a stuck delivery debuggable: "why has this not retried" is
-- answerable by looking, rather than by recomputing a backoff in your head.
--
-- NOT storing the notification's title and body here. The feed row already
-- holds them and `entity_id` already points at it, so a retry rebuilds the
-- payload with a join. Copying customer-facing content into a second table
-- would duplicate a deletion obligation as well as the text.

BEGIN;

ALTER TABLE web_push_deliveries
    ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

COMMENT ON COLUMN web_push_deliveries.next_retry_at IS
    'When a failed delivery becomes eligible again. NULL on a terminal row and '
    'on one never attempted. Set by the sender on failure and cleared on '
    'success, mirroring mobile_push_deliveries.';

-- The worker's claim scan: eligible, unfinished work in due order.
CREATE INDEX IF NOT EXISTS web_push_deliveries_retry_idx
    ON web_push_deliveries (next_retry_at)
    WHERE terminal_at IS NULL AND next_retry_at IS NOT NULL;

COMMIT;
