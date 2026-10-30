-- 0322_quiet_hours_per_recipient.sql
--
-- G16 campaigns-2026 follow-up: make recipient-local quiet-hours
-- evaluation an operator-visible sending setting. The send loop already
-- supports subscriber.timezone-aware checks; this column carries the
-- explicit tenant choice through settings/status APIs and defaults to
-- true to preserve the shipped send-loop behavior for existing tenants.

BEGIN;

ALTER TABLE tenant_sending_settings
    ADD COLUMN IF NOT EXISTS quiet_hours_per_recipient boolean NOT NULL DEFAULT true;

COMMIT;
