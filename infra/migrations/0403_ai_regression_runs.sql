-- 0403_ai_regression_runs.sql
--
-- One row per (tenant, model/prompt version) golden-set replay batch.
-- Triggered manually by an operator or by a model/prompt version bump.
--
-- status:      pending -> running -> completed | failed
-- gate_result: null until completed; then one of
--   'pass'     score >= warn_threshold (and >= hard_gate_threshold if a
--              hard gate is in force).
--   'advisory' score below warn_threshold but the tenant has NOT opted in
--              to a hard gate (or has too few examples to gate on).
--   'fail'     score below hard_gate_threshold AND the tenant opted in to
--              a hard gate with an eligible (N >= min) golden set.
--
-- fidelity_score_p25 (tail) matters as much as the mean for brand voice:
-- one badly-regressed surface should be visible even if the mean is fine.
--
-- rollback-strategy: no-op - additive table.

BEGIN;

CREATE TABLE IF NOT EXISTS ai_regression_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    model_id            text NOT NULL DEFAULT 'unknown',
    model_version_tag   text NOT NULL,   -- e.g. "gemini-3-flash-preview@2026-06-15"
    prompt_version_tag  text NOT NULL DEFAULT 'v1',
    status              text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    total_examples      int  NOT NULL DEFAULT 0,
    passed_examples     int  NOT NULL DEFAULT 0,
    fidelity_score_mean float8,
    fidelity_score_p25  float8,
    gate_result         text CHECK (gate_result IN ('pass', 'fail', 'advisory')),
    -- Thresholds snapshotted from tenant settings at run time so a later
    -- settings change never silently re-interprets a historical run.
    warn_threshold      float8 NOT NULL DEFAULT 60.0,
    hard_gate_threshold float8,           -- null = no hard gate for this run
    error_message       text,
    started_at          timestamptz,
    completed_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_regression_runs_tenant_idx
    ON ai_regression_runs (tenant_id, created_at DESC);

-- "Is a run already in flight for this tenant?" (TriggerRun 409 guard) and
-- the worker's pending pickup.
CREATE INDEX IF NOT EXISTS ai_regression_runs_status_idx
    ON ai_regression_runs (tenant_id, status, created_at)
    WHERE status IN ('pending', 'running');

GRANT SELECT, INSERT, UPDATE ON ai_regression_runs TO postwave_app;

ALTER TABLE ai_regression_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_regression_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ai_regression_runs
    AS PERMISSIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY ai_regression_runs_worker_select ON ai_regression_runs
    AS PERMISSIVE FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
