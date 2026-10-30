-- Native provider delete webhooks need durable evidence rows after removing
-- canonical commerce rows.
ALTER TABLE commerce_events
    DROP CONSTRAINT IF EXISTS commerce_events_event_type_check;

ALTER TABLE commerce_events
    ADD CONSTRAINT commerce_events_event_type_check CHECK (event_type IN (
        'customer_created',
        'customer_deleted',
        'product_created',
        'product_deleted',
        'order_created',
        'order_deleted',
        'order_refunded',
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
