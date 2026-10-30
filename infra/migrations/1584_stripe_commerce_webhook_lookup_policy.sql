-- Public Stripe commerce webhooks are resolved by configured Stripe account ID.
-- Non-Connect account webhooks use ?account_id=acct_... on the endpoint URL;
-- Connect events can also carry the account field in the signed event body.
DROP POLICY IF EXISTS commerce_integrations_stripe_webhook_lookup ON commerce_integrations;
CREATE POLICY commerce_integrations_stripe_webhook_lookup ON commerce_integrations
    AS PERMISSIVE
    FOR SELECT
    USING (
        provider = 'stripe'
        AND status = 'connected'
        AND (
            lower(COALESCE(shop_domain, '')) =
                lower(NULLIF(current_setting('app.stripe_account_id', true), ''))
            OR lower(COALESCE(settings->>'account_id', '')) =
                lower(NULLIF(current_setting('app.stripe_account_id', true), ''))
        )
    );
