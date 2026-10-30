-- Public Webflow form-submission webhooks resolve before tenant context exists.
-- Bind provider, site id, and optional form/form-element ids so multiple forms
-- on one site route to the matching integration instead of the newest site row.
DROP POLICY IF EXISTS lead_integrations_webflow_webhook_lookup ON lead_integrations;
CREATE POLICY lead_integrations_webflow_webhook_lookup ON lead_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.lead_provider', true), '')
        AND provider = 'webflow'
        AND status IN ('connected', 'error', 'needs_auth')
        AND (
            lower(COALESCE(settings->>'site_id', '')) =
                lower(NULLIF(current_setting('app.lead_site_id', true), ''))
            OR lower(COALESCE(settings->>'webflow_site_id', '')) =
                lower(NULLIF(current_setting('app.lead_site_id', true), ''))
            OR lower(COALESCE(settings->>'provider_site_id', '')) =
                lower(NULLIF(current_setting('app.lead_site_id', true), ''))
        )
        AND (
            lower(COALESCE(
                NULLIF(btrim(settings->>'form_id'), ''),
                NULLIF(btrim(settings->>'webflow_form_id'), ''),
                NULLIF(btrim(settings->>'provider_form_id'), ''),
                ''
            )) = ''
            OR lower(COALESCE(
                NULLIF(btrim(settings->>'form_id'), ''),
                NULLIF(btrim(settings->>'webflow_form_id'), ''),
                NULLIF(btrim(settings->>'provider_form_id'), ''),
                ''
            )) = lower(NULLIF(current_setting('app.lead_form_id', true), ''))
        )
        AND (
            lower(COALESCE(
                NULLIF(btrim(settings->>'form_element_id'), ''),
                NULLIF(btrim(settings->>'element_id'), ''),
                NULLIF(btrim(settings->>'webflow_form_element_id'), ''),
                NULLIF(btrim(settings->>'provider_form_element_id'), ''),
                ''
            )) = ''
            OR lower(COALESCE(
                NULLIF(btrim(settings->>'form_element_id'), ''),
                NULLIF(btrim(settings->>'element_id'), ''),
                NULLIF(btrim(settings->>'webflow_form_element_id'), ''),
                NULLIF(btrim(settings->>'provider_form_element_id'), ''),
                ''
            )) = lower(NULLIF(current_setting('app.lead_form_element_id', true), ''))
        )
    );
