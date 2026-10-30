-- 1569_analytics_reporting_provider_parity.sql
-- Promote privacy analytics, enterprise analytics, and BI/reporting tools
-- into the managed analytics integration control plane.

ALTER TABLE analytics_integrations
    DROP CONSTRAINT IF EXISTS analytics_integrations_provider_check;

ALTER TABLE analytics_integrations
    ADD CONSTRAINT analytics_integrations_provider_check
    CHECK (provider IN (
        'ga4',
        'google-tag-manager',
        'segment',
        'rudderstack',
        'mixpanel',
        'amplitude',
        'posthog',
        'heap',
        'hotjar',
        'fullstory',
        'plausible',
        'fathom-analytics',
        'matomo',
        'adobe-analytics',
        'looker-studio',
        'looker',
        'tableau',
        'power-bi',
        'mode',
        'metabase',
        'sisense'
    ));
