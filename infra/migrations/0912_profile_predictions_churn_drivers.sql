-- 0912_profile_predictions_churn_drivers.sql
--
-- SUB-060 — churn risk with explainable drivers.
--
-- profile_predictions (migration 0206) already carries a churn_risk scalar
-- (numeric(6,5)) plus a freeform `explanation` jsonb blob holding
-- order_count / historic_clv_cents / churn_score / model / data_sufficiency.
-- That blob is for debugging the heuristic, not for the operator: it has no
-- ranked, human-readable "why is this profile at risk?" signal.
--
-- Klaviyo's churn surface shows the operator the TOP DRIVERS of a churn
-- prediction (recency, soft-bounce trend, frequency decline, …) with an
-- impact score per driver. This migration adds a first-class `churn_drivers`
-- jsonb column to profile_predictions holding the top-3 explainable drivers
-- as a structured array:
--
--   [
--     {"key":"recency","label":"Days since last order","value":"182","impact":"high"},
--     {"key":"frequency_trend","label":"Order cadence","value":"slowing","impact":"medium"},
--     {"key":"soft_bounce_trend","label":"Soft-bounce trend","value":"none","impact":"low"}
--   ]
--
-- The column is additive + nullable-with-default so existing rows and the
-- existing upsert path keep working; ComputePrediction now fills it during
-- the model run and the GET /api/v1/predictive/profiles/{email} endpoint
-- surfaces it under Prediction.ChurnDrivers. No data backfill is needed —
-- the next predictive recompute populates every row.

BEGIN;

ALTER TABLE profile_predictions
    ADD COLUMN IF NOT EXISTS churn_drivers jsonb NOT NULL DEFAULT '[]';

COMMIT;
