-- 1548_wpforms_lead_provider_parity.sql
-- Promote WPForms from catalog/planned to the managed lead-capture control plane.

ALTER TABLE lead_integrations
    DROP CONSTRAINT IF EXISTS lead_integrations_provider_check;

ALTER TABLE lead_integrations
    ADD CONSTRAINT lead_integrations_provider_check
    CHECK (provider IN (
        'typeform',
        'jotform',
        'gravity-forms',
        'wpforms',
        'wordpress',
        'webflow',
        'wix',
        'squarespace'
    ));
