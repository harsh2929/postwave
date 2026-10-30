-- 1561_shipping_provider_parity_batch.sql
-- Promote shipping, fulfillment, and post-purchase platforms into the managed
-- subscription/shipping connector control plane.

ALTER TABLE subscription_integrations
    DROP CONSTRAINT IF EXISTS subscription_integrations_provider_check;

ALTER TABLE subscription_integrations
    ADD CONSTRAINT subscription_integrations_provider_check
    CHECK (provider IN (
        'recharge',
        'skio',
        'aftership',
        'shipstation',
        'shippo',
        'easyship',
        'shipbob',
        'easypost',
        'narvar',
        'route',
        'malomo',
        'wonderment',
        'bold-subscriptions',
        'ordergroove',
        'loop-subscriptions',
        'appstle',
        'seal-subscriptions',
        'chargebee'
    ));
