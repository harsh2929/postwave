-- 0167_campaign_recipients_claim_state.sql
--
-- Closes the send-pipeline crash-recovery double-send vector
-- documented in the send-pipeline audit:
--
--   The send loop SELECT...FOR UPDATE SKIP LOCKEDs a batch of
--   `pending` rows, holds the lock across the Listmonk POST, then
--   UPDATEs to 'sent'. On worker crash between Listmonk success
--   and the local commit, the tx rolls back, the row reverts to
--   `pending`, and the next claim re-sends. Listmonk's open-source
--   /api/tx does not dedupe on the Idempotency-Key header we send,
--   so the second POST is a real second send.
--
-- The fix is a "claim-then-send" state machine matching the
-- outbox worker pattern:
--
--   1. Atomic UPDATE pending → sending, claimed_at=now(),
--      committed BEFORE the Listmonk call.
--   2. Listmonk POST.
--   3. Atomic UPDATE sending → sent (or sending → failed) in a
--      fresh tx, committed AFTER the Listmonk call.
--
-- A row stuck in `sending` for > 10 min (worker crashed mid-call)
-- is detected by a recovery sweep that flips it back to `pending`.
-- Worst case: the row gets re-attempted with the same
-- Idempotency-Key, which Listmonk MAY dedupe (best-effort) and the
-- subscriber MAY see a duplicate. The window for that is bounded
-- to the sweep interval; the prior code was unbounded.
--
-- Schema changes (additive only — safe to roll forward):
--   * Add 'sending' to the status CHECK constraint.
--   * Add nullable `claimed_at timestamptz` so the recovery sweep
--     can identify stuck rows.
--   * Partial index on (claimed_at) WHERE status = 'sending' so
--     the sweep query is fast even with millions of `sent` rows
--     in the table.

BEGIN;

ALTER TABLE campaign_recipients
    DROP CONSTRAINT IF EXISTS campaign_recipients_status_check;

ALTER TABLE campaign_recipients
    ADD CONSTRAINT campaign_recipients_status_check
    CHECK (status = ANY (ARRAY[
        'pending'::text,
        'sending'::text,
        'sent'::text,
        'failed'::text,
        'cancelled'::text,
        'skipped'::text
    ]));

ALTER TABLE campaign_recipients
    ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

COMMIT;

-- Index is built outside the transaction (CONCURRENTLY can't run
-- inside BEGIN/COMMIT). Partial — only the small set of currently-
-- in-flight rows are indexed, keeping the index tiny.
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_recipients_stuck_claim_idx
    ON campaign_recipients (claimed_at)
    WHERE status = 'sending';
