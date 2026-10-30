-- 0128_eq_score_history.sql
--
-- EQ-Score history table. The eqscore package grades a draft and
-- returns a 0..100 number; this migration persists that number so
-- downstream consumers (the pre-send placement predictor's
-- engagement-risk component, the tenant dashboard's EQ-trend chart,
-- the agency reseller report) can read a rolling-window average.
--
-- Why a separate table, not a column on campaigns / sends:
--
--   * Operators call /api/v1/deliverability/eq-score from the editor
--     preview path BEFORE a campaign exists. We need to record those
--     drafts too — the campaign_id may be NULL.
--
--   * One campaign may be re-graded several times as the operator
--     iterates the subject + body. We want every grade, not just the
--     last one — the placement predictor's discipline-pattern signal
--     wants to know whether you ITERATE toward a good grade or
--     whether your first draft already was one.
--
--   * Re-using a separate table keeps RLS simple (a single tenant_id
--     guard) and the index strategy obvious (tenant + at DESC).
--
-- Sub-score columns (content_score, auth_score, reputation_score) are
-- nullable because the reputation sub-score is skipped for tenants
-- without history. Storing them denormalised lets the dashboard chart
-- "your auth score has been climbing for 14 days" without re-running
-- the grader.

BEGIN;

CREATE TABLE IF NOT EXISTS eq_score_history (
    id                bigserial PRIMARY KEY,
    tenant_id         uuid NOT NULL,
    -- Optional foreign keys; ON DELETE SET NULL so a deleted campaign
    -- doesn't drop its grading history.
    campaign_id       uuid,
    -- A free-text label so the editor preview path can group
    -- iterations on the same draft. Operators can pass any short
    -- identifier ("subject_a", "body_v3", etc.).
    draft_label       text,
    score             int  NOT NULL CHECK (score >= 0 AND score <= 100),
    grade             text NOT NULL,
    content_score     int  CHECK (content_score IS NULL OR (content_score >= 0 AND content_score <= 100)),
    auth_score        int  CHECK (auth_score IS NULL OR (auth_score >= 0 AND auth_score <= 100)),
    reputation_score  int  CHECK (reputation_score IS NULL OR (reputation_score >= 0 AND reputation_score <= 100)),
    -- The "From" address is captured so multi-domain tenants can
    -- segment their EQ trend per sender. Optional; the preview path
    -- often has no From yet.
    from_address      text,
    -- at = grading instant. Indexed for the rolling-window queries.
    at                timestamptz NOT NULL DEFAULT now()
);

-- The hot path: AvgScoreLast30d for the predict-enrichment query.
-- Composite index on (tenant_id, at DESC) lets the planner serve the
-- range scan + filter in one index seek.
CREATE INDEX IF NOT EXISTS idx_eq_score_history_tenant_at
    ON eq_score_history (tenant_id, at DESC);

GRANT SELECT, INSERT ON eq_score_history TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE eq_score_history_id_seq TO postwave_app;

ALTER TABLE eq_score_history ENABLE ROW LEVEL SECURITY;

-- Standard tenant-isolation policy. The eqscore endpoint always has
-- a resolved tenant on the request, so the GUC is guaranteed bound
-- before INSERT.
CREATE POLICY tenant_visible ON eq_score_history AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
