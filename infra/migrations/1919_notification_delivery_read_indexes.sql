-- 1919_notification_delivery_read_indexes.sql
--
-- ECO-05: the notification delivery ledgers get their first READ path
-- (`GET /api/v1/notifications/deliveries` and
-- `GET /api/v1/notifications/{id}/deliveries`). Until now every query against
-- these tables was a WRITE or a worker sweep, so the access patterns a person
-- asking "why didn't I get that?" needs were never indexed.
--
-- Two of the three per-user ledgers were already covered:
--   * web_push_deliveries          — web_push_deliveries_user_idx (tenant, user, created_at DESC)
--   * notification_webhook_deliveries — notification_webhook_deliveries_user_idx (same shape)
--     and its identity index (tenant, notification, user) serves the per-notification lookup.
--
-- mobile_push_deliveries had NEITHER. Its three indexes are the unique
-- (device_id, idempotency_key) send key and two partial worker-sweep indexes on
-- (status, next_retry_at); none of them can answer "this person's recent
-- deliveries" or "this notification's mobile attempt". It is also the highest
-- volume of the three — one row per device per notification — so the read path
-- would have seq-scanned the largest table on every call.
--
-- The web push entity index closes the last per-notification lookup: web push
-- stores the cross-channel notification id in `entity_id` (see
-- webpush/deliveries.go — recordAttempt passes n.NotificationID into that
-- column), and nothing indexed it.
--
-- Indexes only. No column, constraint or policy changes: the read path
-- deliberately reads exactly what the writers already record, because a read
-- surface that needs the ledger reshaped to be answerable is a sign the ledger
-- was not recording the answer in the first place.

BEGIN;

CREATE INDEX IF NOT EXISTS mobile_push_deliveries_user_idx
    ON mobile_push_deliveries (tenant_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mobile_push_deliveries_notification_idx
    ON mobile_push_deliveries (tenant_id, notification_id)
    WHERE notification_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS web_push_deliveries_entity_idx
    ON web_push_deliveries (tenant_id, entity_id)
    WHERE entity_id <> '';

COMMIT;
