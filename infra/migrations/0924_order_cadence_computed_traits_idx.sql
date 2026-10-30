-- 0924_order_cadence_computed_traits_idx.sql
--
-- SUB-061 (Expected Date of Next Order per profile) +
-- SUB-062 (Average time between orders per profile).
--
-- Both features are replenishment-cadence signals derived from a
-- subscriber's order history (commerce_orders.ordered_at, joined to the
-- subscriber by email) and stored as subscriber_computed_traits rows
-- (table 0324) under three well-known keys:
--
--   * average_days_between_orders  — value_type 'number'
--   * expected_next_order_at       — value_type 'datetime'
--                                    (= last_order_at + average_days)
--   * last_order_at                — value_type 'datetime'
--                                    (the cadence-window anchor)
--
-- A commerce worker (internal/commerce/replenishment_cadence_analyzer.go)
-- recomputes the three traits from commerce_orders as order events arrive;
-- the subscribers package reads them back via:
--   * GET/PATCH /api/v1/subscribers/{id}/replenishment-cadence  (SUB-061)
--   * inline hydration on GET /api/v1/subscribers/{id}          (SUB-062)
--
-- No new table is required — this fully reuses the existing computed-traits
-- infrastructure. This migration only adds a partial index so the cadence
-- read endpoints and the worker's per-subscriber upsert both get a tight
-- scan over just the three cadence keys, rather than scanning the whole
-- per-subscriber trait set. Mirrors 0439 (catalog computed-traits idx).
--
-- rollback-strategy: additive, index-only. Hard rollback =
-- DROP INDEX subscriber_computed_traits_cadence_idx.

BEGIN;

CREATE INDEX IF NOT EXISTS subscriber_computed_traits_cadence_idx
    ON subscriber_computed_traits (tenant_id, subscriber_id, key)
    WHERE key IN ('average_days_between_orders', 'expected_next_order_at', 'last_order_at');

COMMENT ON INDEX subscriber_computed_traits_cadence_idx IS
    'SUB-061/SUB-062 partial index over the replenishment-cadence computed-trait keys (average_days_between_orders, expected_next_order_at, last_order_at) so the cadence read endpoints + worker upsert scan only those rows.';

COMMIT;
