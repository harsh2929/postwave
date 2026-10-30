-- 1654_crm_sms_subscriber_providers.sql
-- Allow CRM-managed SMS subscriber providers that now have manual REST
-- subscriber backfill runtimes wired into the CRM integration surface.

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
        'highlevel',
        'postscript',
        'attentive'
    ));
