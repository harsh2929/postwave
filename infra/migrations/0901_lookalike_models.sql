-- 0901_lookalike_models.sql
--
-- SUB-033 — lookalike audiences (model metadata).
--
-- A lookalike audience is generated from a SEED segment: the system ranks
-- non-seed subscribers by first-party similarity to the seed's members
-- (email domain, signup source, engagement tier, churn tier — NO
-- third-party cookies / data brokers) and materialises the top-N as a new
-- audience. Klaviyo / Mailchimp ship the same first-party-only pattern.
--
-- This table stores one row per generated lookalike model: which seed
-- segment it was built from, the requested size + confidence threshold, a
-- freeform model version, the per-run feature/seed-stats payload, and the
-- realised member count. The materialised members live in lookalike_members
-- (migration 0902) so this row stays a compact metadata header the
-- Audiences UI lists + a "Discard" can DELETE (cascading the members).
--
-- Design notes:
--   * seed_segment_id references segments(id); ON DELETE CASCADE so deleting
--     the seed segment discards its derived lookalike models (the modeled
--     audience is meaningless once the seed is gone).
--   * size_requested is the operator's target audience size (100..10000,
--     enforced at the handler). member_count is what the ranker actually
--     produced (≤ size_requested; the candidate pool can be smaller).
--   * confidence_threshold in [0,1] drops candidates whose similarity score
--     falls below it. NULL = no floor (take the top size_requested).
--   * model_version is a freeform short string the generator stamps so a
--     ranking-algorithm swap ships without a migration (same convention as
--     subscriber_predictions, migration 0344).
--   * status tracks the generation lifecycle so a future async generator can
--     report progress; the synchronous create path lands rows as 'ready'.
--   * payload (jsonb) carries seed stats + feature weights for the
--     explainability panel.
--
-- RLS uses the project's standard
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid idiom.

BEGIN;

CREATE TABLE IF NOT EXISTS lookalike_models (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                 text        NOT NULL DEFAULT '',
    seed_segment_id      uuid        NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    size_requested       integer     NOT NULL DEFAULT 1000
        CHECK (size_requested >= 1 AND size_requested <= 100000),
    member_count         integer     NOT NULL DEFAULT 0,
    seed_count           integer     NOT NULL DEFAULT 0,
    confidence_threshold numeric(5,4)
        CHECK (confidence_threshold IS NULL OR (confidence_threshold >= 0 AND confidence_threshold <= 1)),
    model_version        text        NOT NULL DEFAULT 'first-party-v1',
    status               text        NOT NULL DEFAULT 'ready'
        CHECK (status IN ('pending','running','ready','failed')),
    payload              jsonb       NOT NULL DEFAULT '{}'::jsonb,
    error                text        NOT NULL DEFAULT '',
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lookalike_models_tenant_idx
    ON lookalike_models (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS lookalike_models_seed_idx
    ON lookalike_models (tenant_id, seed_segment_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON lookalike_models TO postwave_app;

ALTER TABLE lookalike_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE lookalike_models FORCE  ROW LEVEL SECURITY;

CREATE POLICY lookalike_models_select ON lookalike_models
    FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY lookalike_models_insert ON lookalike_models
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY lookalike_models_update ON lookalike_models
    FOR UPDATE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY lookalike_models_delete ON lookalike_models
    FOR DELETE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

COMMIT;
