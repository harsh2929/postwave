-- Allow tenantless HubSpot Service Hub app-webhook routing by portal before the
-- delivery can be attached to its owning tenant. A supplied provider webhook id
-- must match exactly, and unscoped rows only match unscoped deliveries.

DROP POLICY IF EXISTS support_integrations_hubspot_service_hub_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_hubspot_service_hub_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'hubspot-service-hub'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            COALESCE(settings->>'portal_id', '') =
                NULLIF(current_setting('app.support_hubspot_portal_id', true), '')
            OR COALESCE(settings->>'hubspot_portal_id', '') =
                NULLIF(current_setting('app.support_hubspot_portal_id', true), '')
            OR COALESCE(settings->>'hubspot_service_hub_portal_id', '') =
                NULLIF(current_setting('app.support_hubspot_portal_id', true), '')
            OR COALESCE(settings->>'provider_portal_id', '') =
                NULLIF(current_setting('app.support_hubspot_portal_id', true), '')
        )
        AND (
            (
                NULLIF(current_setting('app.support_hubspot_webhook_id', true), '') IS NOT NULL
                AND COALESCE(settings->>'hubspot_service_hub_webhook_id', settings->>'hubspot_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                    NULLIF(current_setting('app.support_hubspot_webhook_id', true), '')
            )
            OR (
                NULLIF(current_setting('app.support_hubspot_webhook_id', true), '') IS NULL
                AND COALESCE(settings->>'hubspot_service_hub_webhook_id', settings->>'hubspot_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            )
        )
    );
