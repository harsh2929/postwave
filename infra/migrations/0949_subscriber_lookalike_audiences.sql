-- 0949_subscriber_lookalike_audiences.sql
--
-- SUB-068 — First-party AI lookalike audiences (subscriber-namespaced model
-- header).
--
-- A lookalike audience is built from a SEED segment: the system ranks
-- non-seed subscribers by first-party similarity to the seed's members
-- (email domain, signup source, engagement tier, churn tier — NO third-party
-- cookies / data brokers) and materialises the top-N. This is the
-- subscriber-page-facing surface (POST /api/v1/subscribers/lookalike) that
-- complements the audiences-page lookalike (SUB-033, migration 0901) — the
-- two share the predictive ranker but keep separate tables so the subscriber
-- UI's saved lookalikes do not collide with the audiences UI's.
--
-- This table stores one row per generated lookalike: which seed segment it
-- was built from, the requested size + confidence floor, a freeform model
-- version, the realised member count, the seed sample size, an optional
-- export target (an audience_destinations id once activated), and a jsonb
-- payload carrying seed stats + feature dims for the explainability panel.
-- The materialised, ranked members live in
-- subscriber_lookalike_members (migration 0950).
--
-- Design notes:
--   * seed_segment_id references segments(id) ON DELETE CASCADE — deleting the
--     seed discards its derived lookalikes (the modeled audience is
--     meaningless once the seed is gone).
--   * confidence_threshold in [0,1] drops candidates below it. NULL = no floor.
--   * exported_destination_id is set when the operator routes the lookalike to
--     an audience_destinations row (the SUB-068 export step); free uuid (no FK)
--     so this migration does not depend on the audiences module's table being
--     present in every fixture.
--   * status tracks the lifecycle so a future async generator can report
--     progress; the synchronous create path lands rows as 'ready'.
--
-- RLS uses the project's standard
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid idiom.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_lookalike_audiences (
    id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                    text        NOT NULL DEFAULT '',
    seed_segment_id         uuid        NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    size_requested          integer     NOT NULL DEFAULT 1000
        CHECK (size_requested >= 1 AND size_requested <= 100000),
    member_count            integer     NOT NULL DEFAULT 0,
    seed_count              integer     NOT NULL DEFAULT 0,
    confidence_threshold    numeric(5,4)
        CHECK (confidence_threshold IS NULL OR (confidence_threshold >= 0 AND confidence_threshold <= 1)),
    model_version           text        NOT NULL DEFAULT 'first-party-v1',
    status                  text        NOT NULL DEFAULT 'ready'
        CHECK (status IN ('pending','running','ready','failed')),
    exported_destination_id uuid,
    payload                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
    error                   text        NOT NULL DEFAULT '',
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriber_lookalike_audiences_tenant_idx
    ON subscriber_lookalike_audiences (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS subscriber_lookalike_audiences_seed_idx
    ON subscriber_lookalike_audiences (tenant_id, seed_segment_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_lookalike_audiences TO postwave_app;

ALTER TABLE subscriber_lookalike_audiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_lookalike_audiences FORCE  ROW LEVEL SECURITY;

CREATE POLICY subscriber_lookalike_audiences_select ON subscriber_lookalike_audiences
    FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_lookalike_audiences_insert ON subscriber_lookalike_audiences
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_lookalike_audiences_update ON subscriber_lookalike_audiences
    FOR UPDATE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_lookalike_audiences_delete ON subscriber_lookalike_audiences
    FOR DELETE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

COMMIT;
