-- Allow tenantless Salesforce Service Cloud CDC relay routing by instance URL
-- before the delivery can be attached to its owning tenant. A supplied relay or
-- provider webhook id must match exactly, and unscoped rows only match unscoped
-- deliveries.

DROP POLICY IF EXISTS support_integrations_salesforce_service_cloud_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_salesforce_service_cloud_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'salesforce-service-cloud'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            trim(trailing '/' from lower(COALESCE(settings->>'instance_url', ''))) =
                NULLIF(current_setting('app.support_salesforce_service_cloud_instance_url', true), '')
            OR trim(trailing '/' from lower(COALESCE(settings->>'api_base_url', ''))) =
                NULLIF(current_setting('app.support_salesforce_service_cloud_instance_url', true), '')
            OR trim(trailing '/' from lower(COALESCE(settings->>'salesforce_instance_url', ''))) =
                NULLIF(current_setting('app.support_salesforce_service_cloud_instance_url', true), '')
            OR trim(trailing '/' from lower(COALESCE(settings->>'provider_instance_url', ''))) =
                NULLIF(current_setting('app.support_salesforce_service_cloud_instance_url', true), '')
        )
        AND (
            (
                NULLIF(current_setting('app.support_salesforce_service_cloud_webhook_id', true), '') IS NOT NULL
                AND COALESCE(settings->>'salesforce_service_cloud_webhook_id', settings->>'salesforce_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                    NULLIF(current_setting('app.support_salesforce_service_cloud_webhook_id', true), '')
            )
            OR (
                NULLIF(current_setting('app.support_salesforce_service_cloud_webhook_id', true), '') IS NULL
                AND COALESCE(settings->>'salesforce_service_cloud_webhook_id', settings->>'salesforce_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            )
        )
    );
