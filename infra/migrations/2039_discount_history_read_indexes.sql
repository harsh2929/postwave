-- 2039_discount_history_read_indexes.sql
--
-- The release-qualified discount surface is a bounded, read-only historical
-- archive. Its stable pages order records by (created_at, id), and each
-- record's PII-free event timeline orders by (redeemed_at, id). The original
-- tenant indexes establish isolation/lookups but leave PostgreSQL sorting an
-- arbitrarily large tenant history for every page.
--
-- Build both indexes online because discount and redemption rows can still be
-- written by provider-owned runtime paths while the archive remains read-only.
--
-- migration-execution: phased
-- rollback-strategy: no-op
-- rollback-details: Retain these read-only covering indexes during an
-- application rollback; removing them would reintroduce unbounded sorts.

CREATE INDEX CONCURRENTLY IF NOT EXISTS discounts_history_page_idx
    ON discounts (tenant_id, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS discount_redemptions_history_page_idx
    ON discount_redemptions (tenant_id, discount_id, redeemed_at DESC, id DESC);
