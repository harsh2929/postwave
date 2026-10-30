-- 0279_segment_subscribers.sql
--
-- sto-segment-subscribers-materialized (P0).
--
-- Problem: send_time_opt.loadSegmentBestHours and
-- send_time_opt.LoadSegmentPattern have JOINed against a table named
-- `segment_subscribers` since they were written, but no migration ever
-- created it. Every call to GET /api/v1/send-time-opt and
-- /api/v1/send-time-opt/heatmap therefore tripped the in-tx fallback
-- (which executed against an already-aborted Postgres transaction),
-- and returned 500 to the desktop. The live UX audit confirmed the
-- segment best-time + heatmap panels silently failed for fresh
-- workspaces.
--
-- Fix: create the table NOW. It's a denormalised cache of (segment,
-- subscriber) membership, refreshed periodically by the materialiser
-- worker (segment_materializer.go) by recompiling segments.query_ast
-- → SQL via segments.CompileAST and writing the resulting subscriber
-- ids in. Endpoints prefer the materialised cache when present, fall
-- back to compiling the AST inline against subscribers when stale or
-- absent.
--
-- Schema choice notes:
--   * (tenant_id, segment_id, subscriber_id) is the natural primary
--     key — a subscriber is in a segment at most once per tenant.
--   * computed_at is the per-row materialisation timestamp; a refresh
--     run sets all rows for a given segment to the same timestamp,
--     which lets callers detect staleness by reading any row's
--     computed_at.
--   * A separate (tenant_id, segment_id) index drives the "all rows
--     for this segment" scan that send_time_opt uses.
--   * RLS via the canonical NULLIF idiom so a missing app.tenant_id
--     GUC fails closed instead of crashing on the empty-string-to-uuid
--     cast (see project_rls_guc_idiom memo).

BEGIN;

CREATE TABLE IF NOT EXISTS segment_subscribers (
    tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    segment_id    uuid        NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    subscriber_id uuid        NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    computed_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, segment_id, subscriber_id)
);

COMMENT ON TABLE segment_subscribers IS
    'Materialised (segment, subscriber) membership cache. Refreshed by the segment materialiser worker; endpoints fall back to compiling segments.query_ast inline when the cache is stale or absent.';

-- Hot-path lookup: "all subscriber_ids for this (tenant, segment)".
-- Used by send_time_opt.loadSegmentBestHours +
-- send_time_opt.LoadSegmentPattern +
-- send_time_opt.loadCampaignRecipients.
CREATE INDEX IF NOT EXISTS segment_subscribers_segment_idx
    ON segment_subscribers (tenant_id, segment_id);

-- Reverse-lookup: "which segments does this subscriber belong to?"
-- Cheaper than scanning + compiling every segment AST against the
-- subscriber. Used by analytics drill-downs and the subscriber
-- detail slideover.
CREATE INDEX IF NOT EXISTS segment_subscribers_subscriber_idx
    ON segment_subscribers (tenant_id, subscriber_id);

-- Staleness check — drives the materialiser worker's "refresh oldest
-- N segments" cron loop.
CREATE INDEX IF NOT EXISTS segment_subscribers_computed_at_idx
    ON segment_subscribers (tenant_id, computed_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON segment_subscribers TO postwave_app;

ALTER TABLE segment_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE segment_subscribers FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON segment_subscribers;
CREATE POLICY tenant_isolation ON segment_subscribers
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON segment_subscribers;
CREATE POLICY tenant_visible ON segment_subscribers
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
