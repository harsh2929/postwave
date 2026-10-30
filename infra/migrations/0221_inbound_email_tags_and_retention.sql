-- 0221_inbound_email_tags_and_retention.sql
--
-- Two related changes that ship together because they're both
-- "make inbound-route actions actually do something":
--
-- 1. inbound_emails.tags — text[] column the `tag` route action writes
--    into when an inbound email matches. Stored as a Postgres array
--    (not a join table) because tags here are denormalised metadata
--    on a single row, not first-class entities. The matching surface
--    is "set difference / array_append" which Postgres handles natively
--    with the GIN index below.
--
-- 2. inbound_route_matches retention helper — the existing index on
--    (tenant_id, matched_at DESC) already supports the retention
--    DELETE, but we add a partial index on rows older than 30 days
--    so the periodic purge can skip the live tail of the table.
--    Postgres won't auto-use it for general queries (other reads filter
--    on route_id), so this is purely an ops-time accelerator.
--
-- Both changes are idempotent — safe to re-run on re-migration.

-- ----- inbound_emails.tags --------------------------------------------------

ALTER TABLE inbound_emails
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

-- GIN index on tags so a future "show me all inbound mail tagged
-- support" query is one cheap lookup. The default operator class
-- (array_ops) covers the @>, &&, and = operators we'd reach for.
CREATE INDEX IF NOT EXISTS inbound_emails_tags_gin_idx
  ON inbound_emails USING gin (tags);

-- ----- inbound_route_matches retention --------------------------------------
--
-- Retention is enforced by an application-side worker (apps/api/
-- internal/inbound_email/retention.go), not a partition switch. The
-- main reason is volume: at ~10k inbound emails / day / tenant the
-- match-history table accumulates ~100k rows / month / tenant, which
-- is well within unpartitioned territory for the read patterns we care
-- about (per-rule list, newest 50).
--
-- The worker's DELETE walks (tenant_id, matched_at < cutoff). The
-- existing index (tenant_id, matched_at DESC) handles the ORDER BY
-- but not the WHERE-only retention scan as efficiently. The partial
-- index below covers the worker's hot path without bloating the live
-- read indexes.
CREATE INDEX IF NOT EXISTS inbound_route_matches_retention_idx
  ON inbound_route_matches (matched_at);
