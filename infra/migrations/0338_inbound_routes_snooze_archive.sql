-- 0337_inbound_routes_snooze_archive.sql
--
-- Phase 1 cross-cutting `p1-bulk-endpoints` item — adds the
-- bookkeeping columns the new bulk-snooze + bulk-archive endpoints
-- need to write to.
--
-- Why two columns instead of one status enum:
--   * `snoozed_until` is a timestamp because operators want to put a
--     rule "to sleep" until a release window passes; matching is gated
--     on `now() < snoozed_until` so a rule re-arms automatically.
--   * `archived_at` is a sticky "operator decided we don't need this
--     anymore, but don't delete it because it has match history" flag.
--     Archived rules are excluded from the matcher unconditionally; they
--     can be un-archived via PATCH (out of scope for this migration).
--
-- Both columns are nullable so existing rows keep current semantics
-- without backfill. The matcher continues to use `enabled = true` as
-- the primary gate; archive + snooze are additive filters.

BEGIN;

ALTER TABLE inbound_routes
    ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
    ADD COLUMN IF NOT EXISTS archived_at   timestamptz;

-- Partial index keeps the active-route lookup cheap. The matcher will
-- WHERE archived_at IS NULL AND (snoozed_until IS NULL OR snoozed_until < now())
-- — the predicate matches the index so PostgreSQL can use it for the
-- enabled scans the Ingest path runs on every inbound email.
CREATE INDEX IF NOT EXISTS idx_inbound_routes_active
    ON inbound_routes (tenant_id, priority)
    WHERE enabled = true AND archived_at IS NULL;

COMMIT;
