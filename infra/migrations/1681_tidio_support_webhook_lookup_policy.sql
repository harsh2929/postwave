-- Allow tenantless Tidio webhook routing by project_public_key before the
-- delivery can be attached to its owning tenant. Signed Tidio callbacks may be
-- further narrowed with an operator-supplied webhook id.

DROP POLICY IF EXISTS support_integrations_tidio_webhook_lookup ON support_integrations;

CREATE POLICY support_integrations_tidio_webhook_lookup ON support_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.support_provider', true), '')
        AND provider = 'tidio'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND lower(COALESCE(settings->>'project_public_key', settings->>'tidio_project_public_key', settings->>'provider_project_public_key', '')) =
            lower(NULLIF(current_setting('app.support_tidio_project_public_key', true), ''))
        AND (
            COALESCE(settings->>'tidio_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
            OR (
                NULLIF(current_setting('app.support_tidio_webhook_id', true), '') IS NOT NULL
                AND COALESCE(settings->>'tidio_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') =
                    NULLIF(current_setting('app.support_tidio_webhook_id', true), '')
            )
        )
    );
