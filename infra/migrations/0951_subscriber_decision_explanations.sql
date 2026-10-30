-- 0951_subscriber_decision_explanations.sql
--
-- SUB-070 — Right-to-explanation for automated decisions (EU AI Act Art. 86).
--
-- A data subject (and the operator on their behalf) has a right to understand
-- WHY an automated system placed them in a segment or included them in a
-- campaign. Migration 0266 (ai_explainability_records) established the pattern
-- for explaining LLM-driven decisions (model, prompt_hash, drivers jsonb);
-- this table is the behavioural-decision analogue: it stores a snapshot of the
-- reasoning behind a subscriber's segment membership or campaign inclusion so
-- the subscriber-detail slideover's "Segment Decisions" panel can surface
-- "matched 3 of 5 conditions in 'High-Engagement'" without recomputing.
--
-- Design notes:
--   * decision_type is 'segment' | 'campaign', pinned via CHECK.
--   * target_id is the segment id or campaign id the decision concerns. It is a
--     free uuid (NOT a FK) because campaigns live in the Listmonk engine, and a
--     segment may be deleted while we still want the historical explanation for
--     audit; rows are tenant-scoped + cascade with the tenant only.
--   * reasoning_snapshot (jsonb) carries the human-readable drivers, e.g.
--     {"matched": 3, "total": 5, "conditions": [{"field":"engagement_score",
--      "comparator":"gte","value":70,"matched":true}, ...], "summary":"..."}.
--   * created_at lets the panel show the most-recent snapshot per (subscriber,
--     decision_type, target).
--   * a partial-unique index keeps one CURRENT snapshot per
--     (tenant, subscriber, decision_type, target) so a re-record replaces in
--     place via ON CONFLICT rather than stacking rows.
--
-- RLS uses the project's standard
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid idiom.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_decision_explanations (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id      uuid        NOT NULL,
    decision_type      text        NOT NULL
        CHECK (decision_type IN ('segment', 'campaign')),
    target_id          uuid        NOT NULL,
    reasoning_snapshot jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, subscriber_id, decision_type, target_id)
);

-- Panel read: "all decisions for this subscriber, newest first".
CREATE INDEX IF NOT EXISTS subscriber_decision_explanations_sub_idx
    ON subscriber_decision_explanations (tenant_id, subscriber_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_decision_explanations TO postwave_app;

ALTER TABLE subscriber_decision_explanations ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_decision_explanations FORCE  ROW LEVEL SECURITY;

CREATE POLICY subscriber_decision_explanations_select ON subscriber_decision_explanations
    FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_decision_explanations_insert ON subscriber_decision_explanations
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_decision_explanations_update ON subscriber_decision_explanations
    FOR UPDATE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_decision_explanations_delete ON subscriber_decision_explanations
    FOR DELETE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

COMMIT;
