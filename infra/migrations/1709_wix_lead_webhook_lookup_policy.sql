-- Reassert the canonical Wix lifecycle lookup after reconciling the historical
-- duplicate 1594 prefix. Migration 1600 added site lookup and needs_auth/error
-- lifecycle states; this late migration must preserve that stricter contract.
DROP POLICY IF EXISTS lead_integrations_wix_webhook_lookup ON lead_integrations;
CREATE POLICY lead_integrations_wix_webhook_lookup ON lead_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.lead_provider', true), '')
        AND provider = 'wix'
        AND status IN ('connected', 'error', 'needs_auth')
        AND (
            lower(COALESCE(settings->>'instance_id', '')) =
                lower(NULLIF(current_setting('app.lead_instance_id', true), ''))
            OR lower(COALESCE(settings->>'wix_instance_id', '')) =
                lower(NULLIF(current_setting('app.lead_instance_id', true), ''))
            OR lower(COALESCE(settings->>'provider_instance_id', '')) =
                lower(NULLIF(current_setting('app.lead_instance_id', true), ''))
            OR lower(COALESCE(settings->>'site_id', '')) =
                lower(NULLIF(current_setting('app.lead_site_id', true), ''))
            OR lower(COALESCE(settings->>'wix_site_id', '')) =
                lower(NULLIF(current_setting('app.lead_site_id', true), ''))
            OR lower(COALESCE(settings->>'provider_site_id', '')) =
                lower(NULLIF(current_setting('app.lead_site_id', true), ''))
            OR lower(COALESCE(settings->>'form_id', '')) =
                lower(NULLIF(current_setting('app.lead_form_id', true), ''))
            OR lower(COALESCE(settings->>'wix_form_id', '')) =
                lower(NULLIF(current_setting('app.lead_form_id', true), ''))
            OR lower(COALESCE(settings->>'provider_form_id', '')) =
                lower(NULLIF(current_setting('app.lead_form_id', true), ''))
        )
    );
