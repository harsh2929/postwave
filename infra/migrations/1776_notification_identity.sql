-- 1776_notification_identity.sql
--
-- Cross-device notification identity + dedup (Apple-level integration
-- blueprint, fix-now items 2+3). The notification_feed row id becomes THE
-- shared notification identity carried by every delivery channel (in-app
-- feed, mobile push, web push, SSE), and `dedupe_key` makes a logical event
-- (e.g. "approval.requested:<id>" for one user) insert-once: a second
-- dispatch of the same logical notification finds the existing row and
-- suppresses the channel fanout, which is what "reaches every device, ONCE"
-- means server-side.
--
-- event_type carries the canonical manifest event (approval.requested,
-- campaign.sent, subscriber.bounced, ...) so clients can group/route on the
-- contract vocabulary instead of the free-form `kind`.
--
-- rollback-strategy: expand-contract — both columns are additive with
-- defaults; dropping them (and the index) restores the prior shape.

BEGIN;

ALTER TABLE notification_feed
    ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS dedupe_key text NOT NULL DEFAULT '';

-- Insert-once per (tenant, recipient, logical notification). Partial: rows
-- without a dedupe key (legacy producers) keep plain-insert semantics.
CREATE UNIQUE INDEX IF NOT EXISTS notification_feed_dedupe_idx
    ON notification_feed (tenant_id, user_id, dedupe_key)
    WHERE dedupe_key <> '';

COMMIT;
