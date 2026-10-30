-- 0404_ai_regression_results.sql
--
-- Per-example score within a regression run. Backs the per-surface
-- breakdown the UI shows ("campaign_draft: 82/100") and the side-by-side
-- original-vs-replayed evidence view (honest-UI: no black-box scoring).
--
-- replayed_output is the new model's response to the stored brief; it is
-- shown next to the original approved output so an operator can see exactly
-- what changed. Nullable because a generation error still records a row
-- (severity='error') with a NULL output.
--
-- rollback-strategy: no-op - additive table; FKs cascade from runs.

BEGIN;

CREATE TABLE IF NOT EXISTS ai_regression_results (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          uuid NOT NULL REFERENCES ai_regression_runs(id) ON DELETE CASCADE,
    tenant_id       uuid NOT NULL,
    -- ON DELETE SET NULL: a golden example deleted mid-run still leaves its
    -- scored result intact (the result is the evidence, not the example).
    example_id      uuid REFERENCES ai_golden_examples(id) ON DELETE SET NULL,
    surface_kind    text NOT NULL,
    replayed_output text,
    fidelity_score  float8,
    breakdown       jsonb,  -- {embedding_similarity, stylistic_distance, vocabulary_overlap, structural_match, combined}
    severity        text CHECK (severity IN ('ok', 'warn', 'critical', 'error')),
    error_message   text,
    scored_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_regression_results_run_idx
    ON ai_regression_results (run_id, surface_kind);

GRANT SELECT, INSERT ON ai_regression_results TO postwave_app;

ALTER TABLE ai_regression_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_regression_results FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ai_regression_results
    AS PERMISSIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
