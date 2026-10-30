-- Allow tenantless Freshdesk automation-webhook routing by account domain before
-- the delivery can be attached to its owning tenant. The handler requires a
-- vault-backed shared secret header before ingesting support rows.

DROP POLICY IF EXISTS support_integrations_freshdesk_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_freshdesk_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'freshdesk'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            regexp_replace(lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', settings->>'domain', settings->>'subdomain', ''), '^https?://', ''))), '\.freshdesk\.com$', '') =
                lower(NULLIF(current_setting('app.support_freshdesk_domain', true), ''))
            OR lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', settings->>'domain', settings->>'subdomain', ''), '^https?://', ''))) =
                lower(NULLIF(current_setting('app.support_freshdesk_domain', true), ''))
            OR lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', settings->>'domain', settings->>'subdomain', ''), '^https?://', ''))) =
                lower(NULLIF(current_setting('app.support_freshdesk_full_domain', true), ''))
        )
        AND (
            NULLIF(current_setting('app.support_freshdesk_webhook_id', true), '') IS NULL
            OR COALESCE(settings->>'freshdesk_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            OR COALESCE(settings->>'freshdesk_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                NULLIF(current_setting('app.support_freshdesk_webhook_id', true), '')
        )
    );
