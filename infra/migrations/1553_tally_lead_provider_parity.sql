-- 1553_tally_lead_provider_parity.sql
-- Promote Tally from generic webhook capture into the managed lead-capture
-- connector control plane.

ALTER TABLE lead_integrations
    DROP CONSTRAINT IF EXISTS lead_integrations_provider_check;

ALTER TABLE lead_integrations
    ADD CONSTRAINT lead_integrations_provider_check
    CHECK (provider IN (
        'typeform',
        'jotform',
        'tally',
        'gravity-forms',
        'wpforms',
        'wordpress',
        'webflow',
        'wix',
        'squarespace'
    ));
