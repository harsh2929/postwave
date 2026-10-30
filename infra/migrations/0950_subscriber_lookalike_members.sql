-- 0950_subscriber_lookalike_members.sql
--
-- SUB-068 — First-party AI lookalike audiences (materialised members).
--
-- The cached, ranked result set for one subscriber_lookalike_audiences row
-- (migration 0949): the top-N non-seed subscribers the first-party similarity
-- ranker selected, each with the similarity score + 1-based rank that placed
-- them and a per-member contributing-feature snapshot for the explainability
-- panel. This is the materialised audience the operator previews (similarity
-- band breakdown) and exports to audience_destinations.
--
-- Design notes:
--   * (audience_id, subscriber_id) is unique so a re-materialise is idempotent
--     per member; deleting the parent audience cascades these.
--   * similarity_score in [0,1] is the ranker's output (1 = most similar to the
--     seed centroid). rank is the 1-based position for stable paging without an
--     ORDER BY over float ties.
--   * email is denormalised for export/activation join efficiency.
--   * features (jsonb) carries the per-member feature snapshot
--     ("matched on domain + engagement tier").
--
-- RLS uses the project's standard
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid idiom.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_lookalike_members (
    id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    audience_id       uuid         NOT NULL REFERENCES subscriber_lookalike_audiences(id) ON DELETE CASCADE,
    subscriber_id     uuid         NOT NULL,
    email             text         NOT NULL DEFAULT '',
    similarity_score  numeric(5,4) NOT NULL DEFAULT 0
        CHECK (similarity_score >= 0 AND similarity_score <= 1),
    rank              integer      NOT NULL DEFAULT 0,
    features          jsonb        NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (audience_id, subscriber_id)
);

-- Member listing is "ORDER BY rank for this audience" — the composite keeps
-- the paginated read off a seq scan and a sort.
CREATE INDEX IF NOT EXISTS subscriber_lookalike_members_rank_idx
    ON subscriber_lookalike_members (tenant_id, audience_id, rank);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_lookalike_members TO postwave_app;

ALTER TABLE subscriber_lookalike_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_lookalike_members FORCE  ROW LEVEL SECURITY;

CREATE POLICY subscriber_lookalike_members_select ON subscriber_lookalike_members
    FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_lookalike_members_insert ON subscriber_lookalike_members
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_lookalike_members_update ON subscriber_lookalike_members
    FOR UPDATE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_lookalike_members_delete ON subscriber_lookalike_members
    FOR DELETE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

COMMIT;
