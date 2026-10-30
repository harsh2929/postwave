-- Public WooCommerce webhooks arrive with only the store source URL.
-- The API binds app.woocommerce_store_url for the lookup transaction.
DROP POLICY IF EXISTS commerce_integrations_woocommerce_webhook_lookup ON commerce_integrations;
CREATE POLICY commerce_integrations_woocommerce_webhook_lookup ON commerce_integrations
    AS PERMISSIVE
    FOR SELECT
    USING (
        provider = 'woocommerce'
        AND (
            lower(trim(trailing '/' from COALESCE(shop_domain, ''))) =
                lower(NULLIF(current_setting('app.woocommerce_store_url', true), ''))
            OR lower(trim(trailing '/' from COALESCE(settings->>'store_url', ''))) =
                lower(NULLIF(current_setting('app.woocommerce_store_url', true), ''))
        )
    );
