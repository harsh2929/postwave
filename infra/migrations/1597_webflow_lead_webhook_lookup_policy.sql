-- Public Webflow form-submission webhooks resolve by provider + site id before
-- tenant context exists. The API binds app.lead_provider and app.lead_site_id
-- for the lookup transaction.
DROP POLICY IF EXISTS lead_integrations_webflow_webhook_lookup ON lead_integrations;
CREATE POLICY lead_integrations_webflow_webhook_lookup ON lead_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.lead_provider', true), '')
        AND provider = 'webflow'
        AND status = 'connected'
        AND (
            lower(COALESCE(settings->>'site_id', '')) =
                lower(NULLIF(current_setting('app.lead_site_id', true), ''))
            OR lower(COALESCE(settings->>'webflow_site_id', '')) =
                lower(NULLIF(current_setting('app.lead_site_id', true), ''))
            OR lower(COALESCE(settings->>'provider_site_id', '')) =
                lower(NULLIF(current_setting('app.lead_site_id', true), ''))
        )
    );
