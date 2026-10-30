-- 1560_analytics_provider_parity_batch.sql
-- Promote PostHog, Heap, Hotjar, FullStory, and Plausible into the managed
-- analytics/CDP connector control plane.

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
        'plausible'
    ));
