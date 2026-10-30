-- 1563_lead_ads_provider_parity.sql
-- Promote Meta and LinkedIn paid lead-capture surfaces into the managed
-- lead integration control plane.

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
        'facebook-lead-ads',
        'linkedin-lead-gen',
        'google-lead-form-extensions',
        'tiktok-lead-generation',
        'snap-lead-ads',
        'reddit-lead-gen',
        'pinterest-lead-ads',
        'tally',
        'gravity-forms',
        'wpforms',
        'wordpress',
        'webflow',
        'wix',
        'squarespace'
    ));
