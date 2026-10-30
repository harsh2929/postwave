-- 0166_concurrent_indexes_and_force_rls.sql
--
-- Forward-fix consolidated from the DB migration safety audit.
-- Addresses:
--
--   CRITICAL (0137, 0158, 0165) — non-CONCURRENTLY indexes on
--   high-cardinality tables (subscribers, campaign_recipients,
--   subscriber_events). For an already-deployed fleet these locked
--   the relevant table for the duration of the build during boot-
--   time rolling deploys (Postgres CREATE INDEX without CONCURRENTLY
--   holds a SHARE lock blocking writes). Fixed forward by creating
--   a CONCURRENTLY index under a NEW name, then dropping the
--   original. On a fresh install the original index sees an empty
--   table and completes instantly anyway, so the new index is just
--   the canonical one going forward.
--
--   MED (0130) — audit_sink_dlq enabled RLS but did not FORCE it,
--   inconsistent with the rest of the tenant tables (subscriber_
--   events, campaigns, sms_*). Without FORCE, the table owner
--   (which any SECURITY DEFINER function would run as) bypasses
--   the policy. Audit logs are exactly the thing we don't want
--   leaking cross-tenant in a misconfig.
--
-- Deploy notes:
--   * NOT wrapped in BEGIN/COMMIT. CREATE INDEX CONCURRENTLY
--     cannot run inside a transaction. The migration runner is
--     already written for this (apps/api/internal/migrationrunner/
--     runner.go:291 — does not wrap migration bodies). Each
--     statement is its own implicit transaction.
--   * Each statement uses IF NOT EXISTS / IF EXISTS so re-running
--     after a partial application is safe.
--   * DROP INDEX CONCURRENTLY also avoids holding the table lock
--     during the drop.

-- ── 0165 subscriber_events ─────────────────────────────────────────
-- Concurrent rebuild of the provider-dedup unique index.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS subscriber_events_provider_uniq_v2
    ON subscriber_events (tenant_id, source, source_event_id)
    WHERE source_event_id IS NOT NULL;

DROP INDEX CONCURRENTLY IF EXISTS subscriber_events_provider_uniq;

-- ── 0158 campaign_recipients ───────────────────────────────────────
-- Concurrent rebuild of the per-campaign-per-email unique index.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS campaign_recipients_campaign_email_uniq_v2
    ON campaign_recipients (campaign_id, lower(subscriber_email));

DROP INDEX CONCURRENTLY IF EXISTS campaign_recipients_campaign_email_uniq;

-- ── 0137 subscribers ───────────────────────────────────────────────
-- Concurrent rebuild of the engagement-score covering index.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscribers_engagement_score_v2
    ON subscribers (tenant_id, engagement_score DESC);

DROP INDEX CONCURRENTLY IF EXISTS idx_subscribers_engagement_score;

-- ── 0130 audit_sink_dlq FORCE RLS ─────────────────────────────────
-- Bring audit_sink_dlq's RLS posture in line with the other tenant
-- tables. ALTER TABLE FORCE ROW LEVEL SECURITY is metadata-only
-- and cheap; the table owner (postwave_app's superuser parent) now
-- evaluates the policy too. Inside a transaction is fine for ALTER.

ALTER TABLE audit_sink_dlq FORCE ROW LEVEL SECURITY;
