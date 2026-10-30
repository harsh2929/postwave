-- 0936_channel_consents_best_send_hour.sql
--
-- SUB-066 — Personalized per-recipient send-time, PER CHANNEL.
--
-- Why this migration:
--   subscribers.best_send_hour (0076) stores ONE modal hour-of-week
--   (0-167) per subscriber, aggregated across every channel. But the
--   optimal time to reach a person on email is rarely the optimal time
--   to reach them on SMS or push — opens cluster by channel. This
--   migration extends the unified per-channel consent table (0488,
--   subscriber_channel_consents, one row per (profile, channel)) with a
--   per-channel best_send_hour cache so the send-time optimizer can track
--   and the API can expose an optimal window per (subscriber, channel).
--
--   Placing the columns on subscriber_channel_consents (rather than a new
--   table) keeps the data model aligned with the existing
--   consent-per-channel design: the row that already answers "can I reach
--   this profile on channel X?" now also answers "and WHEN is the best
--   time on channel X?".
--
-- Backward-compatible:
--   * The legacy subscribers.best_send_hour aggregate is untouched and
--     remains the fallback when a (subscriber, channel) row has no
--     per-channel value.
--   * Both new columns are nullable; cold (channel, subscriber) pairs stay
--     NULL and resolve at send-time to the aggregate / tenant fallback.
--
-- rollback-strategy: additive. Hard rollback =
--   ALTER TABLE subscriber_channel_consents
--     DROP COLUMN best_send_hour, DROP COLUMN best_send_hour_at;

BEGIN;

ALTER TABLE subscriber_channel_consents
    ADD COLUMN IF NOT EXISTS best_send_hour    smallint
        CHECK (best_send_hour IS NULL OR (best_send_hour >= 0 AND best_send_hour <= 167)),
    ADD COLUMN IF NOT EXISTS best_send_hour_at timestamptz;

COMMENT ON COLUMN subscriber_channel_consents.best_send_hour IS
    'SUB-066 per-channel modal hour-of-week (0-167, UTC-bucketed). NULL = cold; fall back to subscribers.best_send_hour.';
COMMENT ON COLUMN subscriber_channel_consents.best_send_hour_at IS
    'SUB-066 when best_send_hour was last computed for this (profile, channel). NULL = never computed.';

-- Staleness / recompute index — mirrors subscribers_best_hour_stale_idx
-- (0076). The nightly per-channel worker scans for rows whose
-- best_send_hour_at is NULL or older than the cutoff, per channel.
CREATE INDEX IF NOT EXISTS subscriber_channel_consents_best_hour_stale_idx
    ON subscriber_channel_consents (tenant_id, channel, best_send_hour_at NULLS FIRST);

COMMIT;
