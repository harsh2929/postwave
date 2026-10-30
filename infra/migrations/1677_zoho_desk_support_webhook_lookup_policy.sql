-- Allow tenantless Zoho Desk webhook routing by organization before the
-- delivery can be attached to its owning tenant. A supplied webhook id must
-- match exactly, and unscoped rows only match unscoped deliveries.

DROP POLICY IF EXISTS support_integrations_zoho_desk_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_zoho_desk_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'zoho-desk'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            COALESCE(settings->>'organization_id', '') =
                NULLIF(current_setting('app.support_zoho_desk_organization_id', true), '')
            OR COALESCE(settings->>'org_id', '') =
                NULLIF(current_setting('app.support_zoho_desk_organization_id', true), '')
            OR COALESCE(settings->>'orgId', '') =
                NULLIF(current_setting('app.support_zoho_desk_organization_id', true), '')
            OR COALESCE(settings->>'zoho_desk_organization_id', '') =
                NULLIF(current_setting('app.support_zoho_desk_organization_id', true), '')
            OR COALESCE(settings->>'provider_organization_id', '') =
                NULLIF(current_setting('app.support_zoho_desk_organization_id', true), '')
        )
        AND (
            (
                NULLIF(current_setting('app.support_zoho_desk_webhook_id', true), '') IS NOT NULL
                AND COALESCE(settings->>'zoho_desk_webhook_id', settings->>'notification_channel_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                    NULLIF(current_setting('app.support_zoho_desk_webhook_id', true), '')
            )
            OR (
                NULLIF(current_setting('app.support_zoho_desk_webhook_id', true), '') IS NULL
                AND COALESCE(settings->>'zoho_desk_webhook_id', settings->>'notification_channel_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            )
        )
    );
