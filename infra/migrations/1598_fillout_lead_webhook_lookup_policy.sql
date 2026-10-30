-- Public Fillout webhooks resolve by provider + form id before tenant context exists.
-- The API binds app.lead_provider and app.lead_form_id for the lookup transaction.
DROP POLICY IF EXISTS lead_integrations_fillout_webhook_lookup ON lead_integrations;
CREATE POLICY lead_integrations_fillout_webhook_lookup ON lead_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.lead_provider', true), '')
        AND provider = 'fillout'
        AND status = 'connected'
        AND (
            lower(COALESCE(settings->>'form_id', '')) =
                lower(NULLIF(current_setting('app.lead_form_id', true), ''))
            OR lower(COALESCE(settings->>'fillout_form_id', '')) =
                lower(NULLIF(current_setting('app.lead_form_id', true), ''))
            OR lower(COALESCE(settings->>'provider_form_id', '')) =
                lower(NULLIF(current_setting('app.lead_form_id', true), ''))
        )
    );
