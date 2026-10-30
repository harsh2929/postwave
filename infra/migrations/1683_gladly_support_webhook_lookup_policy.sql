-- Allow tenantless Gladly webhook routing by organization domain before the
-- delivery can be attached to its owning tenant. A stored Gladly webhook id may
-- further narrow public callback routing.

DROP POLICY IF EXISTS support_integrations_gladly_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_gladly_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'gladly'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            lower(split_part(trim(both '/' from regexp_replace(COALESCE(settings->>'organization_domain', settings->>'organization_id', settings->>'gladly_organization_domain', settings->>'account_domain', settings->>'domain', settings->>'subdomain', ''), '^https?://', '')), '/', 1)) =
                lower(NULLIF(current_setting('app.support_gladly_organization_domain', true), ''))
            OR lower(split_part(trim(both '/' from regexp_replace(COALESCE(settings->>'organization_domain', settings->>'organization_id', settings->>'gladly_organization_domain', settings->>'account_domain', settings->>'domain', settings->>'subdomain', ''), '^https?://', '')), '/', 1)) =
                lower(NULLIF(current_setting('app.support_gladly_bare_domain', true), ''))
            OR lower(split_part(trim(both '/' from regexp_replace(COALESCE(settings->>'organization_domain', settings->>'organization_id', settings->>'gladly_organization_domain', settings->>'account_domain', settings->>'domain', settings->>'subdomain', ''), '^https?://', '')), '/', 1)) =
                lower(NULLIF(current_setting('app.support_gladly_bare_domain', true), '') || '.gladly.com')
            OR lower(split_part(trim(both '/' from regexp_replace(COALESCE(settings->>'organization_domain', settings->>'organization_id', settings->>'gladly_organization_domain', settings->>'account_domain', settings->>'domain', settings->>'subdomain', ''), '^https?://', '')), '/', 1)) =
                lower(NULLIF(current_setting('app.support_gladly_bare_domain', true), '') || '.gladly.qa')
        )
        AND (
            (
                NULLIF(current_setting('app.support_gladly_webhook_id', true), '') IS NOT NULL
                AND COALESCE(settings->>'gladly_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                    NULLIF(current_setting('app.support_gladly_webhook_id', true), '')
            )
            OR (
                NULLIF(current_setting('app.support_gladly_webhook_id', true), '') IS NULL
                AND COALESCE(settings->>'gladly_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            )
        )
    );
