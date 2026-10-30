-- Allow Wix lead/CMS app lifecycle webhooks to move an installed app back from
-- needs_auth after a merchant reinstalls the Wix app.

ALTER TABLE lead_integrations
    DROP CONSTRAINT IF EXISTS lead_integrations_status_check;

ALTER TABLE lead_integrations
    ADD CONSTRAINT lead_integrations_status_check
    CHECK (status IN ('connected', 'active', 'paused', 'error', 'disconnected', 'needs_auth'));

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

DROP POLICY IF EXISTS lead_integrations_wix_instance_webhook_lookup ON lead_integrations;
CREATE POLICY lead_integrations_wix_instance_webhook_lookup ON lead_integrations
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
        )
    );
