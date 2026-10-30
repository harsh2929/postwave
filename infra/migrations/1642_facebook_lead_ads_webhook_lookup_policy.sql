-- Public Facebook Lead Ads leadgen callbacks resolve by provider + Page id +
-- Lead Form id before tenant context exists. The API binds app.lead_provider,
-- app.lead_page_id, and app.lead_form_id for the lookup transaction.
DROP POLICY IF EXISTS lead_integrations_facebook_lead_ads_webhook_lookup ON lead_integrations;
CREATE POLICY lead_integrations_facebook_lead_ads_webhook_lookup ON lead_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.lead_provider', true), '')
        AND provider = 'facebook-lead-ads'
        AND status IN ('connected', 'error', 'needs_auth')
        AND lower(COALESCE(settings->>'page_id', '')) =
            lower(NULLIF(current_setting('app.lead_page_id', true), ''))
        AND lower(COALESCE(settings->>'form_id', '')) =
            lower(NULLIF(current_setting('app.lead_form_id', true), ''))
    );
