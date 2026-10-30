-- 0344_sto_predictive_clv.sql
--
-- Phase 3 SOTA `sto-predictive-clv` (P2, XL) — adds an ML-backed
-- subscriber prediction surface (Predicted CLV, churn-risk, Expected
-- Date of Next Order, avg time between orders, predicted gender /
-- age). Klaviyo / Mailchimp / Braze / MoEngage / HubSpot all ship
-- equivalents; this migration lays the storage foundation a weekly
-- training worker will populate and the segment builder will read.
--
-- Design notes:
--   * One row per (tenant_id, subscriber_id) — the worker overwrites in
--     place via INSERT ... ON CONFLICT (..) DO UPDATE so segment query
--     paths read a snapshot, not a time series. Historical lineage
--     lives on `subscriber_prediction_runs` (audit + drift tracking).
--   * Columns are nullable where the model cannot speak with
--     confidence under the minimum-data thresholds documented in
--     MIGRATION.md (500+ customers, 180+ days history). The segment
--     compiler is expected to treat NULLs as "no signal" rather than
--     "zero".
--   * `model_version` is a freeform short string the worker sets
--     (e.g. `heuristic-v1`, `btyd-v1`, `xgb-churn-v2`) so a future
--     model swap can ship behind a feature flag without a migration.
--   * `payload` (jsonb) carries per-model extras (e.g. BTYD-NBD
--     alpha/beta, gender prob distribution, top features for SHAP).
--     Keeping it as jsonb keeps the column count bounded as more
--     vendor-parity outputs land.
--   * `subscriber_prediction_runs` mirrors the existing
--     `profile_predictions` / `profile_rfm_scores` heuristic surface
--     but is scoped to the ML training job (model_key + version +
--     window + counts + metrics). The two surfaces coexist: the
--     heuristic v1 keeps powering the dashboards (cheap, deterministic),
--     while this STO surface backs segments + flows requiring the
--     vendor-parity outputs.
--
-- RLS uses the project's standard NULLIF(current_setting('app.tenant_id',
-- true), '')::uuid idiom so the GUC-unset case doesn't crash. Workers
-- bypass via `app.outbox_worker`.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_predictions (
    tenant_id                  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id              uuid        NOT NULL,
    -- Predicted lifetime value over the model's forecast horizon
    -- (defaults to 365 days). Cents so we stay in integer arithmetic
    -- everywhere the segment compiler touches it.
    clv_predicted_cents        bigint,
    -- Churn risk in [0,1]. NULL = below minimum-data threshold.
    churn_risk_score           numeric(5,4),
    -- Expected Date of Next Order (EDONO in vendor parlance).
    expected_next_order_at     timestamptz,
    -- Avg days between historical orders. Backs the "Avg Time Between
    -- Orders" profile property in the segment builder.
    avg_days_between_orders    numeric(8,2),
    -- Predicted lifetime order count over the same forecast horizon
    -- as clv_predicted_cents.
    predicted_order_count      numeric(8,2),
    -- Predicted demographic outputs. Parity with Klaviyo's "Predicted
    -- Gender" / "Predicted Age" profile properties. Both nullable;
    -- gender is one of {male, female, unknown}; age is the modal age
    -- bucket midpoint (NULL when confidence < threshold).
    predicted_gender           text        CHECK (predicted_gender IN ('male','female','unknown') OR predicted_gender IS NULL),
    predicted_age_years        smallint,
    -- Model confidence in [0,1], the same scale segments expose to
    -- operators ("only target predictions with confidence >= 0.7").
    confidence                 numeric(5,4),
    -- Free-form classification of how much data the model had. Mirrors
    -- the heuristic surface so the segment UI can reuse copy.
    data_sufficiency           text        CHECK (data_sufficiency IN ('sufficient','limited','insufficient') OR data_sufficiency IS NULL),
    -- Short identifier the worker stamps; lets us A/B model versions
    -- behind a feature flag without a schema change.
    model_version              text        NOT NULL DEFAULT 'btyd-v0-scaffold',
    -- Per-model extras (BTYD parameters, SHAP top features, gender
    -- prob distribution, etc.). See MIGRATION.md.
    payload                    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- When the worker last produced this snapshot.
    computed_at                timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, subscriber_id)
);

-- Segment-builder hot paths filter on (tenant_id, churn_risk_score)
-- and (tenant_id, clv_predicted_cents). Two partial indexes keep the
-- index small by skipping rows where the model couldn't score.
CREATE INDEX IF NOT EXISTS idx_subscriber_predictions_clv
    ON subscriber_predictions (tenant_id, clv_predicted_cents DESC)
    WHERE clv_predicted_cents IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscriber_predictions_churn
    ON subscriber_predictions (tenant_id, churn_risk_score DESC)
    WHERE churn_risk_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscriber_predictions_edono
    ON subscriber_predictions (tenant_id, expected_next_order_at)
    WHERE expected_next_order_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscriber_predictions_computed_at
    ON subscriber_predictions (tenant_id, computed_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_predictions TO postwave_app;

ALTER TABLE subscriber_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_predictions FORCE  ROW LEVEL SECURITY;

CREATE POLICY subscriber_predictions_select ON subscriber_predictions
    FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_predictions_insert ON subscriber_predictions
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_predictions_update ON subscriber_predictions
    FOR UPDATE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_predictions_delete ON subscriber_predictions
    FOR DELETE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

-- Training-run audit trail. Lets the dashboard surface "last refresh",
-- the worker do drift detection by comparing metrics across runs, and
-- the support team root-cause "why isn't my predicted CLV updating?".
CREATE TABLE IF NOT EXISTS subscriber_prediction_runs (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- 'clv' | 'churn' | 'edono' | 'gender' | 'age' | 'composite'
    model_key              text        NOT NULL,
    model_version          text        NOT NULL,
    status                 text        NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','succeeded','failed','skipped_insufficient_data')),
    input_window_days      integer     NOT NULL DEFAULT 365,
    -- Counts the worker reports back. `insufficient_profiles` covers
    -- subscribers whose history was below the 500-customers / 180-days
    -- threshold documented in MIGRATION.md.
    scored_profiles        integer     NOT NULL DEFAULT 0,
    insufficient_profiles  integer     NOT NULL DEFAULT 0,
    -- Free-form per-model metrics (AUC, calibration MAE, BTYD log-likelihood,
    -- SHAP feature importance, etc.) — see MIGRATION.md for the schema.
    metrics                jsonb       NOT NULL DEFAULT '{}'::jsonb,
    error                  text        NOT NULL DEFAULT '',
    started_at             timestamptz,
    completed_at           timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriber_prediction_runs_tenant
    ON subscriber_prediction_runs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_subscriber_prediction_runs_model
    ON subscriber_prediction_runs (tenant_id, model_key, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_prediction_runs TO postwave_app;

ALTER TABLE subscriber_prediction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_prediction_runs FORCE  ROW LEVEL SECURITY;

CREATE POLICY subscriber_prediction_runs_select ON subscriber_prediction_runs
    FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_prediction_runs_insert ON subscriber_prediction_runs
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_prediction_runs_update ON subscriber_prediction_runs
    FOR UPDATE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_prediction_runs_delete ON subscriber_prediction_runs
    FOR DELETE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

COMMIT;
