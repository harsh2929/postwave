-- Allow tenantless Kayako webhook routing by account domain before the delivery
-- can be attached to its owning tenant. Kayako webhook endpoints are operator
-- configured, so the supplied route token must match exactly.

DROP POLICY IF EXISTS support_integrations_kayako_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_kayako_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'kayako'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            regexp_replace(
                lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', settings->>'domain', settings->>'subdomain', ''), '^https?://', ''))),
                '\.kayako\.com$',
                ''
            ) = NULLIF(current_setting('app.support_kayako_domain', true), '')
            OR lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', settings->>'domain', settings->>'subdomain', ''), '^https?://', ''))) =
                NULLIF(current_setting('app.support_kayako_full_domain', true), '')
        )
        AND COALESCE(settings->>'kayako_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
            NULLIF(current_setting('app.support_kayako_webhook_id', true), '')
    );
