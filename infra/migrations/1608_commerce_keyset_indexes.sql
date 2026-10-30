-- 1608_commerce_keyset_indexes.sql
--
-- Keyset-pagination support for the commerce list endpoints (4.1).
--
-- The commerce list endpoints (apps/api/internal/commerce) now page on
-- (sort_col, id) with ORDER BY <sort_col> DESC, id DESC instead of
-- LIMIT/OFFSET.
--
-- Index shape note: these queries filter the scope with
-- `integration_id::text = $2` (a text cast), so a plain b-tree index on the
-- uuid `integration_id` column CANNOT serve that predicate. The only
-- equality predicate compared in its native type is `tenant_id = $1::uuid`.
-- The usable keyset index therefore LEADS with tenant_id followed directly
-- by the ordering columns (<sort_col> DESC, id DESC) — the planner range-
-- scans the tenant partition in sort order, seeks to the cursor, and applies
-- the integration_id / status predicates as cheap row filters while walking.
-- (Putting integration_id between tenant_id and the sort column would defeat
-- the ORDER BY, since it can't be an equality seek through the ::text cast.)
--
-- Most commerce tables already carry such a trailing-sort index
-- (e.g. (tenant_id, status, updated_at DESC), (tenant_id, product_id,
-- observed_at DESC), (tenant_id, customer_email, ordered_at DESC),
-- (tenant_id, integration_id, event_type, at DESC)). The four below had NO
-- index ordered by their sort column for the integration-scoped list path
-- and would otherwise sort the full tenant partition on every page.

BEGIN;

CREATE INDEX IF NOT EXISTS commerce_customers_tenant_updated_keyset_idx
    ON commerce_customers (tenant_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS commerce_products_tenant_updated_keyset_idx
    ON commerce_products (tenant_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS back_in_stock_subscriptions_tenant_requested_keyset_idx
    ON back_in_stock_subscriptions (tenant_id, requested_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS price_drop_watchers_tenant_watched_keyset_idx
    ON price_drop_watchers (tenant_id, watched_at DESC, id DESC);

COMMIT;
