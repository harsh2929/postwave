-- Allow tenantless Front webhook routing by inbox before the delivery can be
-- attached to its owning tenant. A supplied provider webhook id must match
-- exactly, and unscoped rows only match unscoped deliveries.

DROP POLICY IF EXISTS support_integrations_front_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_front_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'front'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            COALESCE(settings->>'inbox_id', '') =
                NULLIF(current_setting('app.support_front_inbox_id', true), '')
            OR COALESCE(settings->>'front_inbox_id', '') =
                NULLIF(current_setting('app.support_front_inbox_id', true), '')
            OR COALESCE(settings->>'provider_inbox_id', '') =
                NULLIF(current_setting('app.support_front_inbox_id', true), '')
        )
        AND (
            (
                NULLIF(current_setting('app.support_front_webhook_id', true), '') IS NOT NULL
                AND COALESCE(settings->>'front_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                    NULLIF(current_setting('app.support_front_webhook_id', true), '')
            )
            OR (
                NULLIF(current_setting('app.support_front_webhook_id', true), '') IS NULL
                AND COALESCE(settings->>'front_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            )
        )
    );
