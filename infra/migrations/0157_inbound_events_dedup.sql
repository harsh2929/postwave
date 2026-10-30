-- 0157_inbound_events_dedup.sql
--
-- Forward-fix for C3 (PRODUCTION_READINESS.md): inbound_webhooks
-- recorded every received event with no source-event-id, so a
-- legitimate provider retry (the webhook sender resending the
-- same event because our 2xx ack got lost) doubled-up the row in
-- `inbound_events` AND re-fired every trigger. The handler should
-- dedupe by a sender-supplied event id (e.g. Linear's X-Event-Id,
-- GitHub's X-GitHub-Delivery, Stripe's id, etc).
--
-- Schema add:
--   * inbound_events.source_event_id  (text, nullable)
--   * partial unique index on (endpoint_id, source_event_id)
--     WHERE source_event_id IS NOT NULL — old rows with no id
--     keep working; new rows that supply one get atomic dedup.
--
-- The handler should ON CONFLICT DO NOTHING on insert; a conflict
-- means "already received, ack with 2xx" — no triggers fire.

BEGIN;

ALTER TABLE inbound_events
    ADD COLUMN IF NOT EXISTS source_event_id text;

CREATE UNIQUE INDEX IF NOT EXISTS inbound_events_endpoint_source_uniq
    ON inbound_events (endpoint_id, source_event_id)
    WHERE source_event_id IS NOT NULL;

COMMIT;
