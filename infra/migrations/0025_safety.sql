-- 0025_safety.sql
--
-- Pre-send safety eval toggle. Enabled by default for every tenant; the
-- safety.Check pipeline (static rules + AUP regex + optional Claude Haiku
-- rubric) blocks a send on `fail` and stamps the audit log on `warn`.

BEGIN;

ALTER TABLE tenants
    ADD COLUMN safety_check_enabled bool NOT NULL DEFAULT true,
    ADD COLUMN approval_notify_email text;

COMMIT;
