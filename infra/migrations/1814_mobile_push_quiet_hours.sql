-- 1814_mobile_push_quiet_hours.sql
-- migration-execution: single-phase
-- rollback-strategy: additive
-- rollback-details: Every change is additive — four defaulted columns on
-- mobile_push_devices, a WIDENED status CHECK on mobile_push_deliveries, and
-- one index. An older API image simply never writes quiet-hours values and
-- never emits the 'suppressed' status, so rolling back needs no data change.
-- (Re-narrowing the CHECK would only be safe after
-- `UPDATE mobile_push_deliveries SET status = 'failed' WHERE status =
-- 'suppressed'`; that is not required for a rollback and is deliberately not
-- performed here.)
--
-- SHELL#12 — quiet hours for mobile push. A remote push is delivered by APNs
-- from THIS server, so a client-side toggle cannot suppress it: the phone is
-- already buzzing by the time the app could decide. The window therefore lives
-- on the device record and is enforced at dispatch
-- (apps/api/internal/mobilepush/quiet_hours.go).
--
-- Window semantics mirror apps/api/internal/sms/quiet_hours.go so the platform
-- has ONE quiet-hours vocabulary:
--   * start_minute/end_minute are minutes-of-day [0,1439] local to the
--     device's IANA timezone;
--   * start < end is a same-day window (09:00 -> 17:00);
--   * start > end crosses midnight (21:00 -> 09:00) — the default;
--   * start = end covers the whole day.
-- Unlike SMS there is no per-weekday list: a person's sleep is nightly, and
-- an unused `days` column would be a second vocabulary to keep in sync.
--
-- NATIVE#33 — the feed's keyset index. GET /api/v1/notifications now orders by
-- (created_at DESC, id DESC) so a cursor is stable while new rows land at the
-- head of the feed; the pre-existing index stops at created_at.

BEGIN;

ALTER TABLE mobile_push_devices
    ADD COLUMN IF NOT EXISTS quiet_hours_enabled boolean NOT NULL DEFAULT false,
    -- 21:00 -> 09:00 local, matching the sms_quiet_hours defaults.
    ADD COLUMN IF NOT EXISTS quiet_hours_start_minute integer NOT NULL DEFAULT 1260,
    ADD COLUMN IF NOT EXISTS quiet_hours_end_minute integer NOT NULL DEFAULT 540,
    ADD COLUMN IF NOT EXISTS quiet_hours_timezone text NOT NULL DEFAULT 'UTC';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'mobile_push_devices'::regclass
           AND conname = 'mobile_push_devices_quiet_hours_window_check'
    ) THEN
        ALTER TABLE mobile_push_devices
            ADD CONSTRAINT mobile_push_devices_quiet_hours_window_check
            CHECK (quiet_hours_start_minute BETWEEN 0 AND 1439
                   AND quiet_hours_end_minute BETWEEN 0 AND 1439);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'mobile_push_devices'::regclass
           AND conname = 'mobile_push_devices_quiet_hours_timezone_check'
    ) THEN
        ALTER TABLE mobile_push_devices
            ADD CONSTRAINT mobile_push_devices_quiet_hours_timezone_check
            CHECK (length(quiet_hours_timezone) BETWEEN 1 AND 64);
    END IF;
END
$$;

-- A push held back by the window is not a failure and must not be retried by
-- the receipt worker (which claims only 'queued'/'failed'). 'suppressed' is a
-- terminal, evidence-only state: the notification_feed row still exists, so
-- the operator sees the notification in-app and can answer "why was I not
-- buzzed?" from mobile_push_deliveries.error_code = 'quiet_hours'.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'mobile_push_deliveries'::regclass
           AND conname = 'mobile_push_deliveries_status_check'
    ) THEN
        ALTER TABLE mobile_push_deliveries
            DROP CONSTRAINT mobile_push_deliveries_status_check;
    END IF;
    ALTER TABLE mobile_push_deliveries
        ADD CONSTRAINT mobile_push_deliveries_status_check
        CHECK (status IN ('queued', 'accepted', 'delivered', 'failed',
                          'revoked', 'suppressed'));
END
$$;

CREATE INDEX IF NOT EXISTS notification_feed_user_keyset_idx
    ON notification_feed (tenant_id, user_id, created_at DESC, id DESC);

COMMIT;
