-- Public BigCommerce webhooks arrive with a producer like stores/{store_hash}.
-- The API binds app.bigcommerce_store_hash for the lookup transaction.
DROP POLICY IF EXISTS commerce_integrations_bigcommerce_webhook_lookup ON commerce_integrations;
CREATE POLICY commerce_integrations_bigcommerce_webhook_lookup ON commerce_integrations
    AS PERMISSIVE
    FOR SELECT
    USING (
        provider = 'bigcommerce'
        AND status = 'connected'
        AND (
            lower(COALESCE(shop_domain, '')) =
                lower(NULLIF(current_setting('app.bigcommerce_store_hash', true), ''))
            OR lower(COALESCE(settings->>'store_hash', '')) =
                lower(NULLIF(current_setting('app.bigcommerce_store_hash', true), ''))
        )
    );

