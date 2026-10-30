-- Harden tenantless Zendesk webhook routing so a supplied provider webhook id
-- must match exactly and unscoped rows only match unscoped deliveries.

DROP POLICY IF EXISTS support_integrations_zendesk_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_zendesk_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'zendesk'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            lower(COALESCE(settings->>'subdomain', '')) =
                lower(NULLIF(current_setting('app.support_zendesk_subdomain', true), ''))
            OR lower(COALESCE(settings->>'zendesk_subdomain', '')) =
                lower(NULLIF(current_setting('app.support_zendesk_subdomain', true), ''))
            OR lower(COALESCE(settings->>'provider_subdomain', '')) =
                lower(NULLIF(current_setting('app.support_zendesk_subdomain', true), ''))
        )
        AND (
            (
                NULLIF(current_setting('app.support_zendesk_webhook_id', true), '') IS NOT NULL
                AND COALESCE(settings->>'zendesk_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                    NULLIF(current_setting('app.support_zendesk_webhook_id', true), '')
            )
            OR (
                NULLIF(current_setting('app.support_zendesk_webhook_id', true), '') IS NULL
                AND COALESCE(settings->>'zendesk_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            )
        )
    );
