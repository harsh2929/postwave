-- 0093_voice_semantic_signatures.sql
--
-- Per-tenant voice-signature cache for the embedding-backed voice
-- profile (Gemini text-embedding-004). One row per tenant. The
-- centroid is the mean of a tenant's representative-sample
-- embeddings — the reference vector for cosine-similarity voice-
-- fidelity scoring (services/voice/internal/profile/fidelity.go).
--
-- Why a dedicated table instead of a column on voice_profiles:
--   - The signature changes on a different cadence than the rest of
--     the profile: a re-cluster keeps the same Stylistic/Tonal but
--     emits a fresh centroid. Pulling it out keeps voice_profiles
--     UPDATE costs flat.
--   - Future versions may store one row per embedding model, keyed
--     by (tenant_id, model_version), so cross-model fidelity scores
--     can be A/B'd. The schema is intentionally close to that shape
--     (tenant_id PK now, composite PK later).
--   - jsonb (rather than a hand-rolled bytea blob) gives us
--     human-readable dumps and integrates with pg_stat_statements
--     without a special decoder.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE POLICY guarded by
-- an existence check.

BEGIN;

CREATE TABLE IF NOT EXISTS voice_semantic_signatures (
    tenant_id                uuid PRIMARY KEY,
    signature                jsonb NOT NULL,                         -- [0.123, -0.456, ...] (defaults to 768 floats)
    model_version            text  NOT NULL,                         -- e.g. "text-embedding-004"
    dimensions               int   NOT NULL,                         -- vector length (768 today)
    built_from_samples_count int,                                    -- count of representative samples that contributed
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CHECK (dimensions > 0),
    CHECK (jsonb_typeof(signature) = 'array')
);

GRANT SELECT, INSERT, UPDATE, DELETE ON voice_semantic_signatures TO postwave_app;

ALTER TABLE voice_semantic_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_semantic_signatures FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'voice_semantic_signatures'
          AND policyname = 'tenant_visible'
    ) THEN
        CREATE POLICY tenant_visible ON voice_semantic_signatures
            AS PERMISSIVE FOR ALL
            TO postwave_app
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    END IF;
END$$;

COMMIT;
