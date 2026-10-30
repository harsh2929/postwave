-- 0165_subscriber_events_dedup.sql
--
-- Forward-fix for a residual gap left by the Postmark replay audit
-- (commit bf78507): engagement events (open/click) ingested via the
-- deliverability webhooks have no dedup column on subscriber_events.
-- That means a replayed Postmark/Mailgun/SES webhook — including
-- both legitimate retries and signature-replay attacks where the
-- attacker captured a valid (body, signature) pair — inserts a
-- duplicate row. Open/click counters inflate; cohort-level
-- engagement metrics drift; automation triggers that fire on first
-- open (e.g. "send follow-up 24h after open") fire repeatedly.
--
-- Suppression-bearing events (bounce, complaint, unsubscribe) are
-- already deduped at the suppressions store via the
-- (tenant_id, source, source_event_id) unique constraint. This
-- migration brings subscriber_events to the same posture.
--
-- Pattern matches 0162_feedback_events_dedup.sql:
--   * Add nullable `source` + `source_event_id` columns. Old rows
--     stay NULL; the partial unique index ignores them entirely so
--     no backfill is required.
--   * Partial unique on (tenant_id, source, source_event_id) where
--     source_event_id IS NOT NULL — handlers writing the new
--     columns get ON CONFLICT DO NOTHING semantics; the legacy
--     code path (no provider id) keeps inserting unconditionally.
--
-- Deploy safety: ALTER ADD COLUMN with no default is metadata-only
-- in modern Postgres (no rewrite). CREATE INDEX is NOT marked
-- CONCURRENTLY here because the table is small at our current
-- scale; switch to CONCURRENTLY (and run outside a tx) if rolling
-- this forward on a larger fleet.

BEGIN;

ALTER TABLE subscriber_events
    ADD COLUMN IF NOT EXISTS source           text,
    ADD COLUMN IF NOT EXISTS source_event_id  text;

CREATE UNIQUE INDEX IF NOT EXISTS subscriber_events_provider_uniq
    ON subscriber_events (tenant_id, source, source_event_id)
    WHERE source_event_id IS NOT NULL;

COMMIT;
