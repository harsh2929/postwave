-- 1627_flow_step_metrics_rollup_unique.sql
--
-- Backs the automation runtime's rolling step-metric counters.
--
-- 0277_flow_step_metrics.sql created flow_step_metrics as a thin, append-only
-- ledger whose design note insists on "no per-subscriber detail ... because
-- flow runs at scale would otherwise inflate the table by 1 row per subscriber
-- per step." The automation engine, however, executes one asynq task per
-- subscriber per node (services/automation/internal/runtime/engine.go), so a
-- plain append would produce exactly that 1-row-per-subscriber-per-step blow-up
-- the original note warned against.
--
-- We therefore roll the engine's per-execution outcomes UP into a single
-- counter row per (tenant, flow, node, action_kind) via ON CONFLICT … DO UPDATE.
-- That keeps the table bounded by flow × node × action_kind regardless of
-- subscriber volume — honouring the anti-inflation intent — at the cost of the
-- original "append-only" property (the row is now a mutable counter).
--
-- The unique index is partial on run_id IS NULL so a future batch path that
-- wants per-run rows (run_id set) can still append without colliding with the
-- engine's rolling counters.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS flow_step_metrics_rollup_uniq
    ON flow_step_metrics (tenant_id, flow_id, node_id, action_kind)
    WHERE run_id IS NULL;

-- 0277 granted only SELECT, INSERT. The rolling counter uses
-- INSERT … ON CONFLICT … DO UPDATE, which PostgreSQL requires the UPDATE
-- privilege for: without it the first write per (tenant, flow, node, kind)
-- inserts fine but every subsequent subscriber's conflict-update fails with
-- "permission denied for table flow_step_metrics". Grant it.
GRANT UPDATE ON flow_step_metrics TO postwave_app;

COMMIT;
