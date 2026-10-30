-- 0902_lookalike_members.sql
--
-- SUB-033 — lookalike audiences (materialised members).
--
-- The cached, ranked result set for one lookalike_models row (migration
-- 0901): the top-N non-seed subscribers the first-party similarity ranker
-- selected, each with the similarity score that placed them so the
-- Audiences UI / export can sort + threshold without recomputing. This is
-- the materialised audience the operator activates to a campaign or exports.
--
-- Design notes:
--   * (model_id, subscriber_id) is unique so a re-materialise is idempotent
--     per member; deleting the parent lookalike_models row cascades these.
--   * similarity_score in [0,1] is the ranker's output (1 = most similar to
--     the seed centroid). rank is the 1-based position so the UI can page
--     "top 100" without an ORDER BY over the score's float ties.
--   * email is denormalised for export/activation join efficiency (same
--     pattern as segment_subscribers / channel_consents).
--   * features (jsonb) carries the per-member contributing-feature snapshot
--     for the explainability panel ("matched on domain + engagement tier").
--
-- RLS uses the project's standard
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid idiom.

BEGIN;

CREATE TABLE IF NOT EXISTS lookalike_members (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    model_id          uuid        NOT NULL REFERENCES lookalike_models(id) ON DELETE CASCADE,
    subscriber_id     uuid        NOT NULL,
    email             text        NOT NULL DEFAULT '',
    similarity_score  numeric(5,4) NOT NULL DEFAULT 0
        CHECK (similarity_score >= 0 AND similarity_score <= 1),
    rank              integer     NOT NULL DEFAULT 0,
    features          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (model_id, subscriber_id)
);

-- Member listing is "ORDER BY rank for this model" — the composite keeps
-- the paginated read off a seq scan and a sort.
CREATE INDEX IF NOT EXISTS lookalike_members_model_rank_idx
    ON lookalike_members (tenant_id, model_id, rank);

GRANT SELECT, INSERT, UPDATE, DELETE ON lookalike_members TO postwave_app;

ALTER TABLE lookalike_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE lookalike_members FORCE  ROW LEVEL SECURITY;

CREATE POLICY lookalike_members_select ON lookalike_members
    FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY lookalike_members_insert ON lookalike_members
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY lookalike_members_update ON lookalike_members
    FOR UPDATE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY lookalike_members_delete ON lookalike_members
    FOR DELETE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

COMMIT;
