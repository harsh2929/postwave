-- 1805_usage_alert_threshold.sql
-- migration-execution: single-phase
-- rollback-strategy: additive
-- rollback-details: Purely additive nullable/defaulted columns; safe to leave
-- in place on rollback.
--
-- Usage/spend alert thresholds (BILL-038). usage_alert_threshold_pct is NULL
-- when the user hasn't opted in (no alert); email_on_usage_alert toggles the
-- email channel for the alert independently of the in-app banner.

ALTER TABLE notification_preferences
    ADD COLUMN IF NOT EXISTS usage_alert_threshold_pct int,
    ADD COLUMN IF NOT EXISTS email_on_usage_alert boolean NOT NULL DEFAULT true;
