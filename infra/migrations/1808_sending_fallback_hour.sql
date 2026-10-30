-- 1808_sending_fallback_hour.sql
-- SETA-041 (gap 3): a fallback send hour (UTC, 0–23) for send-time optimization
-- recipients with no engagement history — the cold-start default the STO engine
-- can fall back to. Stored alongside the other tenant sending guardrails
-- (quiet hours) on tenant_sending_settings. NULL = "no explicit fallback"
-- (engine keeps its built-in cold-start behavior).

ALTER TABLE tenant_sending_settings
    ADD COLUMN IF NOT EXISTS fallback_hour_utc smallint;

ALTER TABLE tenant_sending_settings
    DROP CONSTRAINT IF EXISTS tenant_sending_settings_fallback_hour_check;
ALTER TABLE tenant_sending_settings
    ADD CONSTRAINT tenant_sending_settings_fallback_hour_check
        CHECK (fallback_hour_utc IS NULL OR (fallback_hour_utc >= 0 AND fallback_hour_utc <= 23));
