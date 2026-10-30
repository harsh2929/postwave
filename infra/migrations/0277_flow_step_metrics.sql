-- 0277_flow_step_metrics.sql
--
-- Per-step truth counters for the flow inspector. Each flow_runs step
-- that executes a tag_add / tag_remove (and future kinds) appends one
-- row recording applied / skipped / failed counts so the UI can show
-- "tag added to 12 subs, 3 skipped, 1 failed" without scanning
-- tag_history.
--
-- We keep this thin and append-only — no per-subscriber detail —
-- because flow runs at scale would otherwise inflate the table by
-- 1 row per subscriber per step.

BEGIN;

CREATE TABLE IF NOT EXISTS flow_step_metrics (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    run_id      uuid,
    flow_id     uuid,
    node_id     text NOT NULL,
    action_kind text NOT NULL,
    applied     integer NOT NULL DEFAULT 0,
    skipped     integer NOT NULL DEFAULT 0,
    failed      integer NOT NULL DEFAULT 0,
    error       text,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS flow_step_metrics_run_idx
    ON flow_step_metrics (tenant_id, run_id, occurred_at DESC)
    WHERE run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS flow_step_metrics_flow_idx
    ON flow_step_metrics (tenant_id, flow_id, occurred_at DESC)
    WHERE flow_id IS NOT NULL;

GRANT SELECT, INSERT ON flow_step_metrics TO postwave_app;

ALTER TABLE flow_step_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_step_metrics FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON flow_step_metrics
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON flow_step_metrics
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
