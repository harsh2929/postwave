-- Public Razorpay commerce webhooks are resolved by configured Razorpay account ID.
-- The API binds app.razorpay_account_id for the lookup transaction before selecting.
DROP POLICY IF EXISTS commerce_integrations_razorpay_webhook_lookup ON commerce_integrations;
CREATE POLICY commerce_integrations_razorpay_webhook_lookup ON commerce_integrations
    AS PERMISSIVE
    FOR SELECT
    USING (
        provider = 'razorpay'
        AND status = 'connected'
        AND (
            lower(COALESCE(shop_domain, '')) =
                lower(NULLIF(current_setting('app.razorpay_account_id', true), ''))
            OR lower(COALESCE(settings->>'account_id', '')) =
                lower(NULLIF(current_setting('app.razorpay_account_id', true), ''))
        )
    );
