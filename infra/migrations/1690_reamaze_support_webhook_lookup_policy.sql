-- Allow tenantless Reamaze webhook routing by account/brand domain and exact
-- route token before the delivery can be attached to its owning tenant.
-- Reamaze webhook signing remains uncertified, so this route requires an
-- operator-generated token in the callback URL.

DROP POLICY IF EXISTS support_integrations_reamaze_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_reamaze_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'reamaze'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            regexp_replace(
                regexp_replace(
                    lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', settings->>'brand', settings->>'subdomain', settings->>'domain', ''), '^https?://', ''))),
                    '\.reamaze\.io$', ''
                ),
                '\.reamaze\.com$', ''
            ) = NULLIF(current_setting('app.support_reamaze_account_domain', true), '')
        )
        AND NULLIF(current_setting('app.support_reamaze_webhook_id', true), '') IS NOT NULL
        AND COALESCE(settings->>'reamaze_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
            NULLIF(current_setting('app.support_reamaze_webhook_id', true), '')
    );
