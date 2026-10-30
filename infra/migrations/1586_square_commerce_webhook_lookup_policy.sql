-- Public Square commerce webhooks are resolved by configured Square merchant ID.
-- The API binds app.square_merchant_id for the lookup transaction before selecting.
DROP POLICY IF EXISTS commerce_integrations_square_webhook_lookup ON commerce_integrations;
CREATE POLICY commerce_integrations_square_webhook_lookup ON commerce_integrations
    AS PERMISSIVE
    FOR SELECT
    USING (
        provider = 'square'
        AND status = 'connected'
        AND (
            lower(COALESCE(shop_domain, '')) =
                lower(NULLIF(current_setting('app.square_merchant_id', true), ''))
            OR lower(COALESCE(settings->>'merchant_id', '')) =
                lower(NULLIF(current_setting('app.square_merchant_id', true), ''))
        )
    );
