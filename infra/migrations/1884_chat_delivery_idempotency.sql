-- 1884_chat_delivery_idempotency.sql
--
-- Stop the chat integrations posting the same message twice.
--
-- `chat_delivery_log` records provider, integration, event type, status and
-- error — an append-only LOG of what happened. It is written AFTER the post, so
-- it can describe a duplicate and cannot prevent one.
--
-- The duplicate is not hypothetical. Slack/Teams/Discord deliveries run through
-- the outbox, which is at-least-once by design: the handler posts, then the
-- worker marks the event complete. A crash, a lease expiry, or a slow ack
-- between those two steps redelivers the event, and the handler posts again. The
-- log then holds two success rows and nothing distinguishes "we notified them
-- twice" from "two things happened".
--
-- `outbox.Event.ID` is the key that closes it, and it was already in the
-- handler's hand — the delivery path just never carried it into the record.
--
-- NULLABLE, and the index is partial. Historical rows have no event id and the
-- "Send test" path has no outbox event at all: a test post is a person clicking
-- a button, where a second click SHOULD send a second message. Forcing a key
-- there would either block a legitimate resend or invent an id that means
-- nothing.

BEGIN;

ALTER TABLE chat_delivery_log
    ADD COLUMN IF NOT EXISTS outbox_event_id uuid;

COMMENT ON COLUMN chat_delivery_log.outbox_event_id IS
    'The outbox event this delivery was for, when there was one. The unique '
    'index below is what makes a redelivered event a no-op instead of a second '
    'message. NULL for operator-triggered test posts, where a second click is '
    'meant to send a second message.';

-- One successful delivery per (integration, outbox event).
--
-- Scoped to `status = success` on purpose: a FAILED attempt must be allowed to
-- try again, and a unique index across all statuses would make the first
-- failure permanent — the same mistake as marking a 429 terminal.
CREATE UNIQUE INDEX IF NOT EXISTS chat_delivery_log_event_idempotent_idx
    ON chat_delivery_log (tenant_id, integration_id, outbox_event_id)
    WHERE outbox_event_id IS NOT NULL AND status = 'success';

-- The lookup the handler does before posting.
CREATE INDEX IF NOT EXISTS chat_delivery_log_event_lookup_idx
    ON chat_delivery_log (tenant_id, outbox_event_id)
    WHERE outbox_event_id IS NOT NULL;

COMMIT;
