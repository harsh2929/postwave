-- 1665_marketing_provider_parity_batch.sql
-- Extend the marketing integration control plane beyond the first Klaviyo row.

BEGIN;

ALTER TABLE marketing_integrations
    DROP CONSTRAINT IF EXISTS marketing_integrations_provider_check;

ALTER TABLE marketing_integrations
    ADD CONSTRAINT marketing_integrations_provider_check
    CHECK (provider IN (
        'klaviyo',
        'mailchimp',
        'activecampaign',
        'customerio',
        'brevo',
        'convertkit'
    ));

COMMIT;
