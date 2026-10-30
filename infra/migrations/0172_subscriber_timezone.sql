-- 0172_subscriber_timezone.sql
--
-- Closes the per-subscriber quiet-hours gap documented in the
-- send-pipeline audit:
--
--   tenant_sending_settings.quiet_hours_tz is a single IANA tz for
--   the WHOLE tenant. For tenants with global lists, quiet-hours
--   enforcement was correct only for subscribers in the tenant's
--   configured TZ. A subscriber at midnight in Tokyo received
--   email while the tenant's US-Eastern quiet window was open.
--
-- Fix: add a nullable `timezone` column to subscribers. The send
-- loop reads it per-row and resolves quiet-hours against the
-- subscriber's local time. NULL falls back to the tenant's TZ
-- (same behavior as today), so no data backfill is required and
-- existing flows keep working unchanged.
--
-- Validation is intentionally minimal: any text accepted, with
-- the QuietHoursChecker falling back to UTC when Go's
-- time.LoadLocation rejects the string. Operators that import
-- subscriber data with malformed TZs see them treated as
-- TZ-less rather than crashing the send loop.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS timezone text;

-- No index — the column is read per-batch in the send loop's body
-- lookup (already keyed by id), never queried in isolation.

COMMIT;
