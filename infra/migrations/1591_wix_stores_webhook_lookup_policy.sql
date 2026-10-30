-- Public Wix Stores webhooks are resolved by configured Wix site/app instance ID.
-- The API binds app.wix_site_id for the lookup transaction before selecting.
-- needs_auth rows remain visible so signed app-installed lifecycle events can
-- recover a Wix app after uninstall/reinstall; the API ignores data webhooks
-- for non-connected integrations after verification.
DROP POLICY IF EXISTS commerce_integrations_wix_stores_webhook_lookup ON commerce_integrations;
CREATE POLICY commerce_integrations_wix_stores_webhook_lookup ON commerce_integrations
    AS PERMISSIVE
    FOR SELECT
    USING (
        provider = 'wix-stores'
        AND status IN ('connected', 'error', 'needs_auth')
        AND (
            lower(COALESCE(shop_domain, '')) =
                lower(NULLIF(current_setting('app.wix_site_id', true), ''))
            OR lower(COALESCE(settings->>'site_id', '')) =
                lower(NULLIF(current_setting('app.wix_site_id', true), ''))
            OR lower(COALESCE(settings->>'instance_id', '')) =
                lower(NULLIF(current_setting('app.wix_site_id', true), ''))
            OR lower(COALESCE(settings->>'store_id', '')) =
                lower(NULLIF(current_setting('app.wix_site_id', true), ''))
        )
    );
