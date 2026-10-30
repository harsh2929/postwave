-- 2011_action_ticket_execution_lease.sql
--
-- Action tickets used to set used_at before invoking their domain action. A
-- transient executor failure therefore destroyed the one-use credential while
-- doing nothing. These fields support a bounded claim -> perform -> complete
-- lifecycle: one request owns the execution lease, failures release it, and a
-- crashed process can be retried after the lease expires.
--
-- execution_id is deliberately ephemeral. used_at remains the durable audit
-- fact; attempts and the bounded stable error code explain retries without
-- persisting provider/database error text.

BEGIN;

ALTER TABLE action_tickets
    ADD COLUMN IF NOT EXISTS execution_id uuid,
    ADD COLUMN IF NOT EXISTS execution_started_at timestamptz,
    ADD COLUMN IF NOT EXISTS execution_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_execution_error_code text;

ALTER TABLE action_tickets
    DROP CONSTRAINT IF EXISTS action_tickets_execution_pair,
    ADD CONSTRAINT action_tickets_execution_pair CHECK (
        (execution_id IS NULL AND execution_started_at IS NULL)
        OR
        (execution_id IS NOT NULL AND execution_started_at IS NOT NULL)
    ),
    DROP CONSTRAINT IF EXISTS action_tickets_execution_attempts_nonnegative,
    ADD CONSTRAINT action_tickets_execution_attempts_nonnegative
        CHECK (execution_attempts >= 0),
    DROP CONSTRAINT IF EXISTS action_tickets_execution_error_code_len,
    ADD CONSTRAINT action_tickets_execution_error_code_len CHECK (
        last_execution_error_code IS NULL
        OR char_length(last_execution_error_code) BETWEEN 1 AND 64
    );

CREATE INDEX IF NOT EXISTS action_tickets_execution_recovery_idx
    ON action_tickets (execution_started_at)
    WHERE used_at IS NULL AND execution_id IS NOT NULL;

COMMENT ON COLUMN action_tickets.execution_id IS
    'Ephemeral owner of a bounded action-execution lease; cleared on release or successful consumption.';
COMMENT ON COLUMN action_tickets.execution_attempts IS
    'Number of execution claims, including crash-recovery retries.';
COMMENT ON COLUMN action_tickets.last_execution_error_code IS
    'Bounded stable failure code only; raw executor errors are never persisted.';

COMMIT;
