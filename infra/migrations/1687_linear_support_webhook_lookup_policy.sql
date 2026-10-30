-- Allow tenantless Linear webhook routing by workspace/organization id before
-- the signed delivery can be attached to its owning tenant. Linear-Signature
-- HMAC-SHA256 verification remains the callback authenticity check.

DROP POLICY IF EXISTS support_integrations_linear_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_linear_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'linear'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND COALESCE(settings->>'workspace_id', settings->>'organization_id', settings->>'linear_workspace_id', settings->>'provider_workspace_id', '') =
            NULLIF(current_setting('app.support_linear_workspace_id', true), '')
        AND (
            NULLIF(current_setting('app.support_linear_webhook_id', true), '') IS NULL
            OR COALESCE(settings->>'linear_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            OR COALESCE(settings->>'linear_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                NULLIF(current_setting('app.support_linear_webhook_id', true), '')
        )
    );
