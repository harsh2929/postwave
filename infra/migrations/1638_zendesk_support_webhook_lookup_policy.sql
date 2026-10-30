-- Allow tenantless Zendesk webhook routing by provider subdomain before the
-- delivery can be attached to its owning tenant. The handler verifies the raw
-- Zendesk signature before ingesting any rows.

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
            NULLIF(current_setting('app.support_zendesk_webhook_id', true), '') IS NULL
            OR COALESCE(settings->>'zendesk_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            OR COALESCE(settings->>'zendesk_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                NULLIF(current_setting('app.support_zendesk_webhook_id', true), '')
        )
    );
