-- Public Wix lead webhooks can resolve by app/site instance id before tenant context exists.
-- The API binds app.lead_provider and app.lead_instance_id for the lookup transaction.
DROP POLICY IF EXISTS lead_integrations_wix_instance_webhook_lookup ON lead_integrations;
CREATE POLICY lead_integrations_wix_instance_webhook_lookup ON lead_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.lead_provider', true), '')
        AND provider = 'wix'
        AND status = 'connected'
        AND (
            lower(COALESCE(settings->>'instance_id', '')) =
                lower(NULLIF(current_setting('app.lead_instance_id', true), ''))
            OR lower(COALESCE(settings->>'wix_instance_id', '')) =
                lower(NULLIF(current_setting('app.lead_instance_id', true), ''))
            OR lower(COALESCE(settings->>'provider_instance_id', '')) =
                lower(NULLIF(current_setting('app.lead_instance_id', true), ''))
        )
    );
