-- 0092_voice_profile_labels.sql
--
-- Hand-labeled tone-axis training data for the voice calibration
-- trainer. Each row is a (sample_text, axis, value) tuple supplied by
-- an operator while reviewing a tenant's representative writing
-- samples — the production source the tone_corpus.DBExporter consumes
-- to replace (or augment) the synthetic in-tree corpus.
--
-- Why one row per (sample, axis) instead of one row per sample with
-- five label columns:
--   - Operators rarely label all five axes in one pass. The narrow
--     shape lets a partial labeling session record exactly what was
--     judged, with no NULL-vs-zero ambiguity.
--   - It makes per-axis aggregation queries trivial (SELECT AVG(value)
--     FROM voice_profile_labels WHERE axis='humor') without unpivoting.
--   - Adding a sixth axis later is an INSERT, not an ALTER TABLE.
--
-- The CHECK on axis pins the allowed values to today's five so a
-- typo in the labeling UI can't poison the trainer with an axis it
-- doesn't know how to project to AxisFeatureWeights.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS
-- + CREATE POLICY guarded by an existence check.

BEGIN;

CREATE TABLE IF NOT EXISTS voice_profile_labels (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    sample_id           text,                                       -- optional: which representative sample
    sample_text         text NOT NULL,                              -- the actual text being labeled (denormalized for stability)
    axis                text NOT NULL,                              -- humor | formality | optimism | directness | warmth
    value               double precision NOT NULL,                  -- 0..1
    labeled_by_user_id  uuid,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (value >= 0.0 AND value <= 1.0),
    CHECK (axis IN ('humor','formality','optimism','directness','warmth'))
);

CREATE INDEX IF NOT EXISTS idx_voice_labels_tenant_axis
    ON voice_profile_labels(tenant_id, axis, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON voice_profile_labels TO postwave_app;

ALTER TABLE voice_profile_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_profile_labels FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'voice_profile_labels'
          AND policyname = 'tenant_visible'
    ) THEN
        CREATE POLICY tenant_visible ON voice_profile_labels
            AS PERMISSIVE FOR ALL
            TO postwave_app
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    END IF;
END$$;

COMMIT;
