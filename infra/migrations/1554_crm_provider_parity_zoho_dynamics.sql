-- 1554_crm_provider_parity_zoho_dynamics.sql
-- Promote Zoho CRM and Microsoft Dynamics 365 into the managed CRM connector
-- control plane.

ALTER TABLE crm_integrations
    DROP CONSTRAINT IF EXISTS crm_integrations_provider_check;

ALTER TABLE crm_integrations
    ADD CONSTRAINT crm_integrations_provider_check
    CHECK (provider IN (
        'hubspot',
        'salesforce',
        'pipedrive',
        'zoho-crm',
        'microsoft-dynamics-365'
    ));
