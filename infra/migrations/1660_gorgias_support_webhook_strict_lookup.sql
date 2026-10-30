-- Harden tenantless Gorgias HTTP-integration callback routing so a supplied
-- integration id must match exactly and unscoped rows only match unscoped
-- deliveries.

DROP POLICY IF EXISTS support_integrations_gorgias_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_gorgias_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'gorgias'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', ''), '^https?://', ''))) =
                lower(NULLIF(current_setting('app.support_gorgias_domain', true), ''))
            OR lower(trim(both '/' from regexp_replace(COALESCE(settings->>'domain', ''), '^https?://', ''))) =
                lower(NULLIF(current_setting('app.support_gorgias_domain', true), ''))
            OR lower(trim(both '/' from regexp_replace(COALESCE(settings->>'subdomain', ''), '^https?://', ''))) =
                lower(NULLIF(current_setting('app.support_gorgias_domain', true), ''))
            OR regexp_replace(lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', settings->>'domain', settings->>'subdomain', ''), '^https?://', ''))), '\.gorgias\.com$', '') =
                lower(NULLIF(current_setting('app.support_gorgias_bare_domain', true), ''))
            OR lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', settings->>'domain', settings->>'subdomain', ''), '^https?://', ''))) =
                lower(NULLIF(current_setting('app.support_gorgias_bare_domain', true), '') || '.gorgias.com')
        )
        AND (
            (
                NULLIF(current_setting('app.support_gorgias_integration_id', true), '') IS NOT NULL
                AND COALESCE(settings->>'gorgias_http_integration_id', settings->>'gorgias_integration_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                    NULLIF(current_setting('app.support_gorgias_integration_id', true), '')
            )
            OR (
                NULLIF(current_setting('app.support_gorgias_integration_id', true), '') IS NULL
                AND COALESCE(settings->>'gorgias_http_integration_id', settings->>'gorgias_integration_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            )
        )
    );
