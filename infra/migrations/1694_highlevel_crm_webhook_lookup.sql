-- HighLevel webhooks resolve by opaque route token before tenant context exists.
-- The API binds app.crm_provider and app.crm_webhook_route_token for lookup.

CREATE INDEX CONCURRENTLY IF NOT EXISTS crm_integrations_highlevel_webhook_route_idx
    ON crm_integrations (
        (settings->>'webhook_route_token'),
        updated_at DESC
    )
    WHERE provider = 'highlevel'
      AND status IN ('connected', 'active');

CREATE INDEX CONCURRENTLY IF NOT EXISTS crm_integrations_highlevel_provider_route_idx
    ON crm_integrations (
        (settings->>'highlevel_webhook_route_token'),
        updated_at DESC
    )
    WHERE provider = 'highlevel'
      AND status IN ('connected', 'active');

DROP POLICY IF EXISTS crm_integrations_highlevel_webhook_lookup ON crm_integrations;
CREATE POLICY crm_integrations_highlevel_webhook_lookup ON crm_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.crm_provider', true), '')
        AND provider = 'highlevel'
        AND status IN ('connected', 'active')
        AND (
            settings->>'webhook_route_token' =
                NULLIF(current_setting('app.crm_webhook_route_token', true), '')
            OR settings->>'highlevel_webhook_route_token' =
                NULLIF(current_setting('app.crm_webhook_route_token', true), '')
        )
    );
