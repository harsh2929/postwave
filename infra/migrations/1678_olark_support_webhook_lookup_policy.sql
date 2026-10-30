-- Allow tenantless Olark transcript-webhook routing by site id before the
-- delivery can be attached to its owning tenant. Olark does not document an
-- HMAC signature for transcript webhooks, so a supplied route token must match
-- the configured webhook id exactly.

DROP POLICY IF EXISTS support_integrations_olark_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_olark_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'olark'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            COALESCE(settings->>'site_id', '') =
                NULLIF(current_setting('app.support_olark_site_id', true), '')
            OR COALESCE(settings->>'olark_site_id', '') =
                NULLIF(current_setting('app.support_olark_site_id', true), '')
            OR COALESCE(settings->>'provider_site_id', '') =
                NULLIF(current_setting('app.support_olark_site_id', true), '')
        )
        AND COALESCE(settings->>'olark_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
            NULLIF(current_setting('app.support_olark_webhook_id', true), '')
    );
