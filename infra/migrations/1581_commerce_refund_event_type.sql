-- WooCommerce global refunds backfill is represented as provider event
-- evidence because core webhooks do not expose refund.created/deleted topics.
ALTER TABLE commerce_events
    DROP CONSTRAINT IF EXISTS commerce_events_event_type_check;

ALTER TABLE commerce_events
    ADD CONSTRAINT commerce_events_event_type_check CHECK (event_type IN (
        'coupon_created',
        'coupon_updated',
        'coupon_deleted',
        'customer_created',
        'customer_deleted',
        'product_created',
        'product_deleted',
        'order_created',
        'order_deleted',
        'order_refunded',
        'refund_created',
        'subscription_created',
        'subscription_updated',
        'subscription_deleted',
        'cart_abandoned',
        'sync_started',
        'sync_completed',
        'sync_failed',
        'catalog_products_imported',
        'cart_recovery_link_created',
        'back_in_stock_requested',
        'back_in_stock_eligible',
        'price_drop_watcher_created',
        'price_drop_eligible',
        'shopify_customer_redacted',
        'shopify_customer_data_requested'
    ));
