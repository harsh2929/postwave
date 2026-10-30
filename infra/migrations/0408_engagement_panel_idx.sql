-- 0408_engagement_panel_idx.sql
--
-- Surfacing Analytics (#3) — honest engagement panel.
--
-- Supports the open-decoupled conversion count in the engagement panel:
-- "conversions attributed to this campaign where the subscriber has zero
-- 'opened' events" (a NOT EXISTS anti-join). The inner side of the
-- anti-join scans campaign_report_events for event_type='opened' and is
-- already covered by the existing campaign_report_events indexes
-- (tenant_id, campaign_id, ...) created in migrations 0027/0339/0397.
--
-- This migration adds a matching partial index on the OUTER side of the
-- anti-join — the conversions table keyed on
-- (tenant_id, campaign_id, attributed_via) restricted to the rows the
-- panel actually counts (campaign-attributed explicit/last_touch) — so
-- the COUNT(*) FILTER stays cheap at any scale.
--
-- CONCURRENTLY (NOT in a transaction): conversions (migration 0049) is a
-- plain bigserial heap, NOT range-partitioned, so CREATE INDEX
-- CONCURRENTLY is available and is the safe choice on a write-hot,
-- real-customer table — a plain CREATE INDEX would take an ACCESS
-- EXCLUSIVE lock for the whole build and block writers (enforced by
-- scripts/lint-migrations.sh, which requires CONCURRENTLY for existing
-- non-allowlisted tables). CONCURRENTLY cannot run inside BEGIN/COMMIT,
-- so there is deliberately no transaction wrapper here. IF NOT EXISTS
-- keeps the migration idempotent/re-runnable.
--
-- RLS note: conversions already has tenant_isolation (FOR ALL) enforced
-- via NULLIF(current_setting('app.tenant_id', true), '')::uuid
-- (migration 0049). No new table and no new RLS policy are introduced
-- here, so the additive-only migration-safety gate
-- (migrationrunner.AssessSafety) passes with no blockers.

CREATE INDEX CONCURRENTLY IF NOT EXISTS conversions_engagement_panel_idx
    ON conversions (tenant_id, campaign_id, attributed_via)
    WHERE campaign_id IS NOT NULL
      AND attributed_via IN ('explicit', 'last_touch');
