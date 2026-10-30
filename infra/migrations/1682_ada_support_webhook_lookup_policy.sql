-- Allow tenantless Ada webhook routing by AI Agent domain before the delivery
-- can be attached to its owning tenant. A supplied provider webhook endpoint
-- id may further narrow public callback routing.

DROP POLICY IF EXISTS support_integrations_ada_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_ada_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'ada'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND lower(split_part(trim(both '/' from regexp_replace(COALESCE(settings->>'ai_agent_domain', settings->>'ada_ai_agent_domain', settings->>'bot_id', settings->>'provider_ai_agent_domain', settings->>'provider_domain', ''), '^https?://', '')), '/', 1)) =
            lower(NULLIF(current_setting('app.support_ada_ai_agent_domain', true), ''))
        AND (
            COALESCE(settings->>'ada_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            OR (
                NULLIF(current_setting('app.support_ada_webhook_id', true), '') IS NOT NULL
                AND COALESCE(settings->>'ada_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                    NULLIF(current_setting('app.support_ada_webhook_id', true), '')
            )
        )
    );
