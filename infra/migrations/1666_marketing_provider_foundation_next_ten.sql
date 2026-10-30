-- 1666_marketing_provider_foundation_next_ten.sql
-- Extend the marketing integration provider-row shell to the next newsletter migration foundations.

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
        'convertkit',
        'substack',
        'beehiiv',
        'mailerlite',
        'sendy',
        'constant-contact',
        'aweber',
        'drip',
        'campaign-monitor',
        'omnisend',
        'loops'
    ));

COMMIT;
