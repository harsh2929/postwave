-- 0439_catalog_computed_traits_idx.sql
--
-- SUB-013 — catalog-linked profile attributes.
--
-- favorite_category / last_viewed_sku are computed from commerce_events
-- (product_viewed / order_created) joined against commerce_products +
-- commerce_catalog_items, then upserted onto the subscriber as
-- subscriber_computed_traits rows (table 0324) under the well-known keys
-- 'favorite_category' and 'last_viewed_sku'. No new table is required —
-- this fully reuses the existing computed-traits infrastructure.
--
-- This migration only adds a partial index so the catalog-attributes
-- read endpoint (GET /api/v1/subscribers/{id}/catalog-attributes) and the
-- worker's per-subscriber upsert both get a tight scan over just the two
-- catalog keys, rather than scanning the whole per-subscriber trait set.
--
-- rollback-strategy: additive, index-only. Hard rollback =
-- DROP INDEX subscriber_computed_traits_catalog_idx.

BEGIN;

CREATE INDEX IF NOT EXISTS subscriber_computed_traits_catalog_idx
    ON subscriber_computed_traits (tenant_id, subscriber_id, key)
    WHERE key IN ('favorite_category', 'last_viewed_sku');

COMMENT ON INDEX subscriber_computed_traits_catalog_idx IS
    'SUB-013 partial index over the catalog-linked computed-trait keys (favorite_category, last_viewed_sku) so the catalog-attributes read + worker upsert scan only those rows.';

COMMIT;
