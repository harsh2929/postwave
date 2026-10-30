-- Allow tenantless Groove webhook routing by mailbox id and exact route token
-- before the delivery can be attached to its owning tenant. Groove's public
-- webhook docs do not document a signature scheme, so the route token is
-- required rather than optional.

DROP POLICY IF EXISTS support_integrations_groove_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_groove_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'groove'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            COALESCE(settings->>'mailbox_id', '') = NULLIF(current_setting('app.support_groove_mailbox_id', true), '')
            OR COALESCE(settings->>'provider_mailbox_id', '') = NULLIF(current_setting('app.support_groove_mailbox_id', true), '')
            OR COALESCE(settings->>'groove_mailbox_id', '') = NULLIF(current_setting('app.support_groove_mailbox_id', true), '')
        )
        AND NULLIF(current_setting('app.support_groove_webhook_id', true), '') IS NOT NULL
        AND COALESCE(settings->>'groove_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
            NULLIF(current_setting('app.support_groove_webhook_id', true), '')
    );
