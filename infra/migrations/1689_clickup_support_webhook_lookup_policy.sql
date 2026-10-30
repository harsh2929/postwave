-- Allow tenantless ClickUp Support webhook routing by workspace/team id before
-- the signed delivery can be attached to its owning tenant. X-Signature
-- HMAC-SHA256 verification remains the callback authenticity check.

DROP POLICY IF EXISTS support_integrations_clickup_support_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_clickup_support_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'clickup-support'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND COALESCE(settings->>'workspace_id', settings->>'team_id', settings->>'clickup_workspace_id', settings->>'provider_workspace_id', '') =
            NULLIF(current_setting('app.support_clickup_workspace_id', true), '')
        AND (
            NULLIF(current_setting('app.support_clickup_webhook_id', true), '') IS NULL
            OR COALESCE(settings->>'clickup_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            OR COALESCE(settings->>'clickup_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                NULLIF(current_setting('app.support_clickup_webhook_id', true), '')
        )
    );
