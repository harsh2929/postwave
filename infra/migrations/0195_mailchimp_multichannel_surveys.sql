-- 0195_mailchimp_multichannel_surveys.sql
--
-- Mailchimp parity follow-up: hosted surveys are a first-class growth surface.
-- Existing popup_forms store the survey definition; growth_surface_events now
-- accepts survey interactions so reports can distinguish hosted surveys from
-- popups and landing pages.

BEGIN;

ALTER TABLE growth_surface_events
    DROP CONSTRAINT IF EXISTS growth_surface_events_surface_type_check;

ALTER TABLE growth_surface_events
    ADD CONSTRAINT growth_surface_events_surface_type_check
    CHECK (surface_type IN ('landing_page', 'popup', 'survey'));

COMMIT;
