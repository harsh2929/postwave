-- 1562_crm_provider_parity_smb_batch.sql
-- Promote additional SMB and sales-led CRM platforms into the managed CRM
-- connector control plane.

ALTER TABLE crm_integrations
    DROP CONSTRAINT IF EXISTS crm_integrations_provider_check;

ALTER TABLE crm_integrations
    ADD CONSTRAINT crm_integrations_provider_check
    CHECK (provider IN (
        'hubspot',
        'salesforce',
        'pipedrive',
        'zoho-crm',
        'microsoft-dynamics-365',
        'keap',
        'close',
        'copper',
        'freshsales',
        'highlevel'
    ));
