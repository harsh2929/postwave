-- 0392_segment_size_history.sql
--
-- feat/full-surface-wiring: segment growth snapshots.
--
-- Daily per-segment membership counts. This is the table
-- segments/size_history.go has anticipated since GAP-LS-081 (its
-- read path already does an optimistic SELECT against
-- segment_size_history and degrades to a live single point when the
-- table is absent). A daily worker (segments/snapshot_worker.go)
-- walks every tenant, compiles each segment's query_ast via
-- CompileAST, COUNTs, and upserts one row per (segment, day).
--
-- NOTE: the cache-style `segment_snapshots` table (0201) is a
-- different feature — an operator-triggered point-in-time freeze
-- with a member sample. This table is the lightweight daily
-- count-only series that backs the growth chart
-- (GET /api/v1/segments/{id}/growth).
--
-- snapshot_date dedupes to one row per segment per day; evaluated_at
-- keeps the exact evaluation instant for the chart's x-axis (and is
-- what size_history.go selects).
--
-- RLS: canonical RESTRICTIVE + PERMISSIVE pair (NULLIF idiom). The
-- snapshot worker writes under per-tenant scope (db.WithTenant), so
-- no worker gate is needed here.
--
-- rollback-strategy: DROP TABLE segment_size_history — the read path
-- in size_history.go already tolerates the table being absent.

BEGIN;

CREATE TABLE IF NOT EXISTS segment_size_history (
    tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    segment_id    UUID        NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    snapshot_date DATE        NOT NULL DEFAULT CURRENT_DATE,
    evaluated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    count         INTEGER     NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, segment_id, snapshot_date)
);

COMMENT ON TABLE segment_size_history IS
    'Daily segment membership counts written by the segment snapshot worker; read by /segments/{id}/growth and /segments/{id}/size-history.';

-- Chart read path: "points for this segment in the last N days".
CREATE INDEX IF NOT EXISTS segment_size_history_segment_idx
    ON segment_size_history (tenant_id, segment_id, evaluated_at ASC);

GRANT SELECT, INSERT, UPDATE, DELETE ON segment_size_history TO postwave_app;

ALTER TABLE segment_size_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE segment_size_history FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON segment_size_history
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON segment_size_history
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
