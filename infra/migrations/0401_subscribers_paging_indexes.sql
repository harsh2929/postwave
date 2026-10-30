-- 0401_subscribers_paging_indexes.sql
--
-- Server-side pagination/search/sort for GET /api/v1/subscribers
-- (p1-server-pagination). The List endpoint now supports OFFSET paging
-- (default), keyset/cursor paging for deep pages, and an allow-listed
-- sort. At 5M subscribers per tenant the default ORDER BY updated_at DESC
-- was unindexed — migration 0003 only created (tenant_id, status),
-- (tenant_id, email), and the tags/custom_fields GINs — so every list
-- page did a tenant-scoped scan + top-N sort. These two composite btrees
-- turn the hot paths into tight index range reads:
--
--   1. (tenant_id, updated_at DESC, id DESC) — serves BOTH the default
--      offset sort (ORDER BY updated_at DESC, id DESC) and the keyset
--      cursor predicate (WHERE (updated_at, id) < (cursor) ORDER BY
--      updated_at DESC, id DESC). The trailing id column makes the order
--      total (tiebreak when many rows share an updated_at after a bulk
--      import) and lets the cursor row-value comparison walk the index in
--      a single direction with no extra sort node.
--
--   2. (tenant_id, email) for sort=email — migration 0003 already has
--      subscribers_tenant_email_idx (tenant_id, email) which serves the
--      UNIQUE(tenant_id, email) lookup AND an ORDER BY email ASC/DESC, so
--      no new email index is needed. Documented here so a future reader
--      doesn't add a duplicate.
--
-- The other allow-listed sorts (created_at, mailchimp_status,
-- engagement_score) intentionally get NO dedicated index here: created_at
-- correlates tightly with updated_at on append-only imports (the
-- updated_at index is good enough), and status/engagement sorts are
-- low-traffic admin views where a tenant-scoped sort is acceptable. Add
-- targeted indexes later if those paths show up hot in pg_stat_statements.
--
-- CREATE INDEX (not CONCURRENTLY): this repo's migrations run inside the
-- BEGIN/COMMIT the runner wraps every file in, and CONCURRENTLY cannot
-- run in a transaction. IF NOT EXISTS keeps re-apply idempotent.
--
-- rollback-strategy: no-op (additive index; safe to leave in place. To
-- reverse manually: DROP INDEX subscribers_tenant_updated_id_idx;).

BEGIN;

CREATE INDEX IF NOT EXISTS subscribers_tenant_updated_id_idx
    ON subscribers (tenant_id, updated_at DESC, id DESC);

COMMIT;
