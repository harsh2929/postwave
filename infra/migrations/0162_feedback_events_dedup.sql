-- 0162_feedback_events_dedup.sql
--
-- Forward-fix for C9 (PRODUCTION_READINESS.md): bounce_events and
-- complaint_events are written per ESP webhook with no dedup —
-- so a Postmark/SendGrid/SES replay (legitimate retry of an event
-- whose 2xx ack got lost) writes duplicate rows. Downstream
-- counts (auto-suppression thresholds, per-tenant complaint
-- rates) double-count.
--
-- Both tables already have esp + esp_message_id columns (which
-- carry the provider's stable event id). Add a partial unique
-- index on (tenant_id, esp, esp_message_id) where the message id
-- is present; rows without one keep the old behaviour. Handlers
-- should INSERT … ON CONFLICT DO NOTHING.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS bounce_events_provider_uniq
    ON bounce_events (tenant_id, esp, esp_message_id)
    WHERE esp_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS complaint_events_provider_uniq
    ON complaint_events (tenant_id, esp, esp_message_id)
    WHERE esp_message_id IS NOT NULL;

COMMIT;
