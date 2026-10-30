-- rollback-strategy: expand-contract - public webhook lookup should remain restricted to connected rows.
-- rollback-details: leave the stricter lookup policies applied during rollback; restore the prior
-- policies from backup only if a rollback must deliberately accept callbacks for disconnected rows.

BEGIN;

DROP POLICY IF EXISTS commerce_integrations_shopify_webhook_lookup ON commerce_integrations;
CREATE POLICY commerce_integrations_shopify_webhook_lookup ON commerce_integrations
    AS PERMISSIVE
    FOR SELECT
    USING (
        provider = 'shopify'
        AND status = 'connected'
        AND lower(shop_domain) = lower(NULLIF(current_setting('app.shopify_shop_domain', true), ''))
    );

DROP POLICY IF EXISTS commerce_integrations_woocommerce_webhook_lookup ON commerce_integrations;
CREATE POLICY commerce_integrations_woocommerce_webhook_lookup ON commerce_integrations
    AS PERMISSIVE
    FOR SELECT
    USING (
        provider = 'woocommerce'
        AND status = 'connected'
        AND (
            lower(trim(trailing '/' from COALESCE(shop_domain, ''))) =
                lower(NULLIF(current_setting('app.woocommerce_store_url', true), ''))
            OR lower(trim(trailing '/' from COALESCE(settings->>'store_url', ''))) =
                lower(NULLIF(current_setting('app.woocommerce_store_url', true), ''))
        )
    );

COMMIT;
