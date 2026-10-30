-- Allow tenantless Help Scout webhook routing by mailbox before the delivery
-- can be attached to its owning tenant. The handler verifies the raw
-- X-HelpScout-Signature HMAC before ingesting support rows.

DROP POLICY IF EXISTS support_integrations_helpscout_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_helpscout_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'help-scout'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            COALESCE(settings->>'mailbox_id', '') =
                NULLIF(current_setting('app.support_helpscout_mailbox_id', true), '')
            OR COALESCE(settings->>'help_scout_mailbox_id', '') =
                NULLIF(current_setting('app.support_helpscout_mailbox_id', true), '')
            OR COALESCE(settings->>'provider_mailbox_id', '') =
                NULLIF(current_setting('app.support_helpscout_mailbox_id', true), '')
        )
        AND (
            NULLIF(current_setting('app.support_helpscout_webhook_id', true), '') IS NULL
            OR COALESCE(settings->>'help_scout_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            OR COALESCE(settings->>'help_scout_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                NULLIF(current_setting('app.support_helpscout_webhook_id', true), '')
        )
    );
