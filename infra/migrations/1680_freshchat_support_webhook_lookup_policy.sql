-- Allow tenantless Freshchat webhook routing by account domain before the
-- delivery can be attached to its owning tenant. Signed Freshchat callbacks may
-- also be narrowed with an operator-supplied route token.

DROP POLICY IF EXISTS support_integrations_freshchat_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_freshchat_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'freshchat'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            regexp_replace(
                regexp_replace(
                    lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', settings->>'domain', settings->>'workspace_url', ''), '^https?://', ''))),
                    '\.freshchat\.com$',
                    ''
                ),
                '\.myfreshworks\.com$',
                ''
            ) = lower(NULLIF(current_setting('app.support_freshchat_domain', true), ''))
            OR lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', settings->>'domain', settings->>'workspace_url', ''), '^https?://', ''))) =
                lower(NULLIF(current_setting('app.support_freshchat_full_domain', true), ''))
            OR lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', settings->>'domain', settings->>'workspace_url', ''), '^https?://', ''))) =
                lower(NULLIF(current_setting('app.support_freshchat_freshworks_domain', true), ''))
        )
        AND (
            (
                NULLIF(current_setting('app.support_freshchat_webhook_id', true), '') IS NOT NULL
                AND COALESCE(settings->>'freshchat_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                    NULLIF(current_setting('app.support_freshchat_webhook_id', true), '')
            )
            OR (
                NULLIF(current_setting('app.support_freshchat_webhook_id', true), '') IS NULL
                AND COALESCE(settings->>'freshchat_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            )
        )
    );
