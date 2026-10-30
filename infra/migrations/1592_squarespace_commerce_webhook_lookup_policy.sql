-- Public Squarespace webhooks resolve by website/site id before tenant context exists.
-- The API binds app.squarespace_site_id for the lookup transaction before selecting.
DROP POLICY IF EXISTS commerce_integrations_squarespace_webhook_lookup ON commerce_integrations;
CREATE POLICY commerce_integrations_squarespace_webhook_lookup ON commerce_integrations
    FOR SELECT
    USING (
        provider = 'squarespace-commerce'
        AND status = 'connected'
        AND (
            lower(COALESCE(shop_domain, '')) =
                lower(NULLIF(current_setting('app.squarespace_site_id', true), ''))
            OR lower(COALESCE(settings->>'site_id', '')) =
                lower(NULLIF(current_setting('app.squarespace_site_id', true), ''))
            OR lower(COALESCE(settings->>'website_id', '')) =
                lower(NULLIF(current_setting('app.squarespace_site_id', true), ''))
            OR lower(COALESCE(settings->>'store_id', '')) =
                lower(NULLIF(current_setting('app.squarespace_site_id', true), ''))
        )
    );
