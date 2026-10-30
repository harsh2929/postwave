-- 1617_analytics_generic_webhook_ingest.sql
--
-- Generic analytics webhook ingest. payments / events (webinars) / cms and any
-- other "profile + event" SaaS tool fundamentally land as a person + an event —
-- exactly what analytics_integrations already models (ProfileInput + EventInput).
-- Rather than a new subsystem per category, add a SINGLE generic ingest path:
-- a per-integration `analytics_ingest_token` (alongside the CDP-specific
-- segment_ingest_token / rudderstack_ingest_token) resolved by the same
-- dummy-tenant RLS lookup, so any provider that can POST a webhook is set-up-able.
--
-- Also drops the enumerated provider CHECK so a long-tail provider slug inserts
-- (mirrors 1616 for the other land-only tables; provider is slug-sanitized at the
-- Go layer and the curated CREATE path still validates against ProviderSpecByKey).

CREATE INDEX IF NOT EXISTS analytics_integrations_generic_ingest_idx
    ON analytics_integrations ((settings->>'analytics_ingest_token'))
    WHERE status IN ('connected', 'active', 'paused', 'error');

DROP POLICY IF EXISTS analytics_integrations_generic_ingest_lookup ON analytics_integrations;
CREATE POLICY analytics_integrations_generic_ingest_lookup ON analytics_integrations
    FOR SELECT
    USING (
        status IN ('connected', 'active', 'paused', 'error')
        AND settings->>'analytics_ingest_token' = NULLIF(current_setting('app.analytics_ingest_token', true), '')
    );

ALTER TABLE analytics_integrations DROP CONSTRAINT IF EXISTS analytics_integrations_provider_check;
