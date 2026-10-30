-- 0900_subscriber_prediction_metadata.sql
--
-- SUB-010 — predictive-score versioning + explainability metadata.
--
-- The subscribers table already caches two predictive scalars directly on
-- the row: churn_score / churn_score_at (migration 0180) and
-- engagement_score / engagement_score_at (migration 0180's engagement
-- sibling). Those are bare numbers with no model lineage — an operator
-- looking at a 0.82 churn score cannot tell which model produced it, how
-- confident the model was, or which features drove the prediction.
--
-- Klaviyo's predictive surface attaches a model version + confidence +
-- per-feature contribution snapshot to every score so the operator gets
-- an explainability ("nutrition-facts") panel. The full STO predictive
-- CLV surface (subscriber_predictions / subscriber_prediction_runs,
-- migration 0344) already encodes that pattern for the ML-backed CLV /
-- churn outputs. This migration adds a *lightweight* parallel for the two
-- cached scalars: one metadata row per (subscriber, score_type) carrying
-- model_version, confidence, and a jsonb feature snapshot, without
-- bloating the hot subscribers row.
--
-- Design notes:
--   * score_type pins the metadata to a specific cached scalar
--     ('churn' | 'engagement'). The unique (tenant_id, subscriber_id,
--     score_type) constraint lets the scorer use INSERT ... ON CONFLICT
--     DO UPDATE so the metadata stays a single current snapshot per score
--     type, not a time series (the audit trail for retraining lives on
--     subscriber_prediction_runs, 0344).
--   * model_version is a freeform short string the scorer stamps
--     (e.g. 'heuristic-v1', 'churn-xgb-v2') so a model swap ships without
--     a migration — same convention as 0344.
--   * confidence is numeric(5,4) in [0,1]; NULL = model declined to score
--     under its minimum-data threshold.
--   * features is jsonb (top contributing features / SHAP-style weights /
--     the raw scalar value snapshot) so the explainability panel can
--     render without a second model call. Defaults to '{}'.
--   * computed_at is when the scorer last produced this snapshot.
--
-- RLS uses the project's standard
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid idiom so the
-- GUC-unset case doesn't crash; the background scorer bypasses via
-- app.outbox_worker, matching the 0344 prediction surface.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_prediction_metadata (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id  uuid        NOT NULL,
    -- Which cached scalar this metadata explains.
    score_type     text        NOT NULL
        CHECK (score_type IN ('churn', 'engagement')),
    -- Freeform model version the scorer stamps (heuristic-v1, churn-xgb-v2, …).
    model_version  text        NOT NULL DEFAULT 'heuristic-v1',
    -- Model confidence in [0,1]. NULL = below the minimum-data threshold.
    confidence     numeric(5,4)
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    -- Per-feature explainability snapshot (top features / weights / raw value).
    features       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- When the scorer last produced this snapshot.
    computed_at    timestamptz NOT NULL DEFAULT now(),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, subscriber_id, score_type)
);

-- Detail-read hydration filters on (tenant_id, subscriber_id); the unique
-- index above already serves that, but an explicit index keeps the
-- version-history list query (ordered by computed_at) off a seq scan.
CREATE INDEX IF NOT EXISTS subscriber_prediction_metadata_sub_idx
    ON subscriber_prediction_metadata (tenant_id, subscriber_id, computed_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_prediction_metadata TO postwave_app;

ALTER TABLE subscriber_prediction_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_prediction_metadata FORCE  ROW LEVEL SECURITY;

CREATE POLICY subscriber_prediction_metadata_select ON subscriber_prediction_metadata
    FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_prediction_metadata_insert ON subscriber_prediction_metadata
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_prediction_metadata_update ON subscriber_prediction_metadata
    FOR UPDATE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_prediction_metadata_delete ON subscriber_prediction_metadata
    FOR DELETE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

COMMIT;
