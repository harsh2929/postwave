-- 0238_retention_policies_dataclasses.sql
--
-- Extend retention_policies with the per-tenant cutoffs the new
-- consolidated retention.Sweeper consumes. All columns are nullable so
-- existing tenants keep their current 3-dimension surface; the Go
-- helpers fall back to package defaults when NULL or zero.
--
-- CHECK ranges match the min/max constants in
-- apps/api/internal/settings/privacy.go. Keep them in sync.
--
-- No new tables -> no new RLS policy required; retention_policies
-- already FORCEs RLS via the canonical NULLIF(current_setting(...),'')
-- pattern (see 0084_workspace_settings.sql).

BEGIN;

ALTER TABLE retention_policies
    ADD COLUMN IF NOT EXISTS engagement_event_retention_days int,
    ADD COLUMN IF NOT EXISTS inbound_email_retention_days    int,
    ADD COLUMN IF NOT EXISTS webhook_delivery_retention_days int,
    ADD COLUMN IF NOT EXISTS form_submission_retention_days  int,
    ADD COLUMN IF NOT EXISTS export_grace_days               int;

-- Ranges: any nullable knob is allowed to be NULL (use default), and
-- when set is bounded so a corrupt patch can't push a sweeper into
-- "delete everything tomorrow" territory.
ALTER TABLE retention_policies
    DROP CONSTRAINT IF EXISTS retention_policies_engagement_event_chk,
    DROP CONSTRAINT IF EXISTS retention_policies_inbound_email_chk,
    DROP CONSTRAINT IF EXISTS retention_policies_webhook_delivery_chk,
    DROP CONSTRAINT IF EXISTS retention_policies_form_submission_chk,
    DROP CONSTRAINT IF EXISTS retention_policies_export_grace_chk;

ALTER TABLE retention_policies
    ADD CONSTRAINT retention_policies_engagement_event_chk
        CHECK (engagement_event_retention_days IS NULL
               OR engagement_event_retention_days BETWEEN 30 AND 2555),
    ADD CONSTRAINT retention_policies_inbound_email_chk
        CHECK (inbound_email_retention_days IS NULL
               OR inbound_email_retention_days BETWEEN 7 AND 2555),
    ADD CONSTRAINT retention_policies_webhook_delivery_chk
        CHECK (webhook_delivery_retention_days IS NULL
               OR webhook_delivery_retention_days BETWEEN 7 AND 2555),
    ADD CONSTRAINT retention_policies_form_submission_chk
        CHECK (form_submission_retention_days IS NULL
               OR form_submission_retention_days BETWEEN 30 AND 2555),
    ADD CONSTRAINT retention_policies_export_grace_chk
        CHECK (export_grace_days IS NULL
               OR export_grace_days BETWEEN 0 AND 365);

COMMIT;
