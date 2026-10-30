-- 0312_sto_per_recipient_timezone.sql
--
-- sto-per-recipient-timezone (P1, surface=send-time).
--
-- BEFORE this migration, Postwave's STO pipeline (send_time_opt/)
-- computed each subscriber's modal hour-of-week ENTIRELY IN UTC.
-- `HourOfWeek(t)` collapsed any timestamp to its UTC weekday * 24 +
-- UTC hour, so a Los Angeles subscriber whose opens cluster at 9am
-- Pacific (17:00 UTC) and a Berlin subscriber whose opens cluster at
-- 9am Central European (07:00 UTC) ended up with totally different
-- best_send_hour values — even though both wanted "9am local". The
-- scheduler then fired each campaign at the stored UTC hour, so the
-- LA recipient got their 9am-local send, but a Berlin recipient in
-- the same modal-hour bucket got it at 18:00 local.
--
-- 2026 SOTA across ESPs:
--
--   * Klaviyo Smart Send Time schedules each recipient at their
--     learned-best LOCAL hour. `Account > Profiles > timezone` is
--     the source of truth, with a fallback to the account's tz.
--   * Braze Intelligent Timing computes best-send relative to
--     `user.time_zone`. Subscribers without a tz fall through to
--     `app group default time zone`.
--   * Iterable Send Time Optimization runs in recipient-local time.
--   * MoEngage Best Time to Send (BTS) is "user time zone" by
--     default; the operator can override to a fixed tz per campaign.
--   * Customer.io "Send at recipient's local time" toggle reads
--     `customer.timezone` per send.
--
-- WHAT THIS MIGRATION DOES:
--
--   * No new schema. `subscribers.timezone` already exists (added
--     in 0172_subscriber_timezone.sql for the quiet-hours per-
--     subscriber gap). The new STO code reads that column.
--   * Adds `sto_per_recipient_tz_enabled` to tenant_send_settings
--     so a tenant can opt out (default ON — matches every modern
--     ESP). When disabled, STO reverts to UTC-only behaviour.
--   * Adds `sto_fallback_timezone` so a tenant can declare the tz
--     to use when subscribers.timezone is NULL. Default 'UTC'
--     matches today's posture (NULL → UTC).
--   * Adds a small index on `subscribers(tenant_id, timezone)` so
--     the schedule-preview's "distribution by tz" group-by doesn't
--     sequential-scan the table on large tenants.
--
-- The actual localisation logic lives in
-- apps/api/internal/send_time_opt/per_recipient_tz.go so it can be
-- unit-tested without a DB. This migration is non-destructive: rows
-- without subscribers.timezone fall back to sto_fallback_timezone
-- (default 'UTC') so existing schedules remain bit-for-bit
-- identical until an operator imports per-subscriber tzs.

BEGIN;

ALTER TABLE tenant_send_settings
    ADD COLUMN IF NOT EXISTS sto_per_recipient_tz_enabled boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS sto_fallback_timezone        text    NOT NULL DEFAULT 'UTC';

-- Index supports the tz-distribution preview AND the per-recipient
-- localisation pass in the scheduler. The partial index excludes
-- NULL-timezone rows because the scheduler always falls through to
-- the tenant fallback for those — there's nothing to look up.
CREATE INDEX IF NOT EXISTS subscribers_tenant_timezone_idx
    ON subscribers (tenant_id, timezone)
    WHERE timezone IS NOT NULL;

-- Pin the fallback to a non-empty string so the resolver can rely
-- on `LoadLocation(tz)` always having something to parse.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tenant_send_settings_sto_fallback_tz_nonempty_chk'
    ) THEN
        ALTER TABLE tenant_send_settings
            ADD CONSTRAINT tenant_send_settings_sto_fallback_tz_nonempty_chk
            CHECK (length(trim(sto_fallback_timezone)) > 0);
    END IF;
END$$;

COMMIT;
