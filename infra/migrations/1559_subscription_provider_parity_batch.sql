-- 1559_subscription_provider_parity_batch.sql
-- Promote additional subscription platforms into the managed subscription,
-- shipping, and fulfillment connector control plane.

ALTER TABLE subscription_integrations
    DROP CONSTRAINT IF EXISTS subscription_integrations_provider_check;

ALTER TABLE subscription_integrations
    ADD CONSTRAINT subscription_integrations_provider_check
    CHECK (provider IN (
        'recharge',
        'skio',
        'aftership',
        'shipstation',
        'bold-subscriptions',
        'ordergroove',
        'loop-subscriptions',
        'appstle',
        'seal-subscriptions',
        'chargebee'
    ));
