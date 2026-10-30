-- 0104_workspace_date_format.sql
--
-- Persist the dashboard workspace date-format preference. The original
-- workspace settings page treated date format as a client-only preference,
-- which meant it reset after reload and could drift across devices.

BEGIN;

ALTER TABLE workspace_settings
    ADD COLUMN IF NOT EXISTS date_format text NOT NULL DEFAULT 'MMM D, YYYY';

ALTER TABLE workspace_settings
    DROP CONSTRAINT IF EXISTS workspace_settings_date_format_chk;

ALTER TABLE workspace_settings
    ADD CONSTRAINT workspace_settings_date_format_chk
    CHECK (date_format IN ('YYYY-MM-DD', 'MMM D, YYYY', 'D MMM YYYY', 'MM/DD/YYYY'));

COMMIT;
