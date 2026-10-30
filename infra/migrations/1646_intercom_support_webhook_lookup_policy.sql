-- Allow tenantless Intercom webhook routing by workspace before the delivery
-- can be attached to its owning tenant. The handler verifies X-Hub-Signature
-- HMAC before ingesting support rows.

DROP POLICY IF EXISTS support_integrations_intercom_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_intercom_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'intercom'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            COALESCE(settings->>'workspace_id', '') =
                NULLIF(current_setting('app.support_intercom_workspace_id', true), '')
            OR COALESCE(settings->>'intercom_workspace_id', '') =
                NULLIF(current_setting('app.support_intercom_workspace_id', true), '')
            OR COALESCE(settings->>'app_id', '') =
                NULLIF(current_setting('app.support_intercom_workspace_id', true), '')
        )
    );
