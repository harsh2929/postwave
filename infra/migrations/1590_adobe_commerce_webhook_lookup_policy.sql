-- Public Adobe Commerce / Magento webhooks are resolved by configured store base URL.
-- The API binds app.adobe_commerce_base_url for the lookup transaction before selecting.
DROP POLICY IF EXISTS commerce_integrations_adobe_commerce_webhook_lookup ON commerce_integrations;
CREATE POLICY commerce_integrations_adobe_commerce_webhook_lookup ON commerce_integrations
    AS PERMISSIVE
    FOR SELECT
    USING (
        provider = 'adobe-commerce'
        AND status = 'connected'
        AND (
            lower(trim(trailing '/' from COALESCE(shop_domain, ''))) =
                lower(NULLIF(current_setting('app.adobe_commerce_base_url', true), ''))
            OR lower(trim(trailing '/' from COALESCE(settings->>'base_url', ''))) =
                lower(NULLIF(current_setting('app.adobe_commerce_base_url', true), ''))
        )
    );
