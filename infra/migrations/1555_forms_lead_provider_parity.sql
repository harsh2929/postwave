-- 1555_forms_lead_provider_parity.sql
-- Promote Google Forms, Microsoft Forms, and SurveyMonkey into the managed
-- lead-capture connector control plane.

ALTER TABLE lead_integrations
    DROP CONSTRAINT IF EXISTS lead_integrations_provider_check;

ALTER TABLE lead_integrations
    ADD CONSTRAINT lead_integrations_provider_check
    CHECK (provider IN (
        'typeform',
        'jotform',
        'google-forms',
        'microsoft-forms',
        'surveymonkey',
        'tally',
        'gravity-forms',
        'wpforms',
        'wordpress',
        'webflow',
        'wix',
        'squarespace'
    ));
