-- Public PayPal commerce webhooks are resolved by configured PayPal merchant ID.
-- The API binds app.paypal_merchant_id for the lookup transaction before selecting.
DROP POLICY IF EXISTS commerce_integrations_paypal_webhook_lookup ON commerce_integrations;
CREATE POLICY commerce_integrations_paypal_webhook_lookup ON commerce_integrations
    FOR SELECT
    USING (
        provider = 'paypal'
        AND status = 'connected'
        AND (
            lower(COALESCE(shop_domain, '')) =
                lower(NULLIF(current_setting('app.paypal_merchant_id', true), ''))
            OR lower(COALESCE(settings->>'merchant_id', '')) =
                lower(NULLIF(current_setting('app.paypal_merchant_id', true), ''))
        )
    );
