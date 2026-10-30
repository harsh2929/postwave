-- Allow native commerce connector health evidence rows written by
-- Repo.SetIntegrationSync and Shopify/WooCommerce privacy/runtime handlers.
ALTER TABLE commerce_events
    DROP CONSTRAINT IF EXISTS commerce_events_event_type_check;

ALTER TABLE commerce_events
    ADD CONSTRAINT commerce_events_event_type_check CHECK (event_type IN (
        'customer_created',
        'product_created',
        'order_created',
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
