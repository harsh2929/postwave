-- Allow tenantless HelpCrunch webhook routing by organization id before the
-- signed delivery can be attached to its owning tenant. A stored webhook id may
-- further narrow public callback routing, but HMAC-SHA1 body verification is
-- the callback authenticity check.

DROP POLICY IF EXISTS support_integrations_helpcrunch_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_helpcrunch_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'helpcrunch'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND COALESCE(settings->>'organization_id', settings->>'helpcrunch_organization_id', settings->>'provider_organization_id', '') =
            NULLIF(current_setting('app.support_helpcrunch_organization_id', true), '')
        AND (
            NULLIF(current_setting('app.support_helpcrunch_webhook_id', true), '') IS NULL
            OR COALESCE(settings->>'helpcrunch_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            OR COALESCE(settings->>'helpcrunch_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                NULLIF(current_setting('app.support_helpcrunch_webhook_id', true), '')
        )
    );
