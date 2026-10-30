-- Allow tenantless Drift app-webhook routing by workspace/org before the
-- delivery can be attached to its owning tenant. A supplied provider webhook id
-- must match exactly, and unscoped rows only match unscoped deliveries.

DROP POLICY IF EXISTS support_integrations_drift_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_drift_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'drift'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            COALESCE(settings->>'workspace_id', '') =
                NULLIF(current_setting('app.support_drift_workspace_id', true), '')
            OR COALESCE(settings->>'drift_workspace_id', '') =
                NULLIF(current_setting('app.support_drift_workspace_id', true), '')
            OR COALESCE(settings->>'organization_id', '') =
                NULLIF(current_setting('app.support_drift_workspace_id', true), '')
            OR COALESCE(settings->>'org_id', '') =
                NULLIF(current_setting('app.support_drift_workspace_id', true), '')
            OR COALESCE(settings->>'drift_organization_id', '') =
                NULLIF(current_setting('app.support_drift_workspace_id', true), '')
            OR COALESCE(settings->>'provider_workspace_id', '') =
                NULLIF(current_setting('app.support_drift_workspace_id', true), '')
            OR COALESCE(settings->>'provider_organization_id', '') =
                NULLIF(current_setting('app.support_drift_workspace_id', true), '')
        )
        AND (
            (
                NULLIF(current_setting('app.support_drift_webhook_id', true), '') IS NOT NULL
                AND COALESCE(settings->>'drift_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                    NULLIF(current_setting('app.support_drift_webhook_id', true), '')
            )
            OR (
                NULLIF(current_setting('app.support_drift_webhook_id', true), '') IS NULL
                AND COALESCE(settings->>'drift_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            )
        )
    );
