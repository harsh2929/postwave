-- Allow tenantless Jira Service Management webhook routing by Atlassian site
-- identifier before the callback can be attached to its owning tenant. Jira
-- OAuth dynamic webhooks do not share the admin-webhook HMAC secret path, so
-- Postwave requires an exact stored route token in the public callback URL.

DROP POLICY IF EXISTS support_integrations_jira_service_management_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_jira_service_management_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'jira-service-management'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            lower(trim(both '/' from regexp_replace(COALESCE(settings->>'site_id', settings->>'cloud_id', settings->>'site_url', settings->>'atlassian_site_id', ''), '^https?://', ''))) =
                NULLIF(current_setting('app.support_jira_service_site_id', true), '')
            OR regexp_replace(lower(trim(both '/' from regexp_replace(COALESCE(settings->>'site_id', settings->>'cloud_id', settings->>'site_url', settings->>'atlassian_site_id', ''), '^https?://', ''))), '\.atlassian\.net$', '') =
                NULLIF(current_setting('app.support_jira_service_site_id', true), '')
        )
        AND COALESCE(settings->>'jira_service_management_webhook_id', settings->>'jira_service_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
            NULLIF(current_setting('app.support_jira_service_webhook_id', true), '')
    );
