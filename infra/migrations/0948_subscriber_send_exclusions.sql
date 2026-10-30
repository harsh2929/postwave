-- 0948_subscriber_send_exclusions.sql
--
-- SUB-067 — Pre-send Audience Refine / Optimization.
--
-- AI-driven send-time suppression with cooling-off re-entry. Before a
-- campaign goes out, the PreSendRefiner gates the audience on each
-- subscriber's cached churn_score (subscribers.churn_score, migration 0180,
-- recomputed every 6h by the subscriberscore package). Subscribers at or
-- above an operator-configurable threshold (default 80/100) are temporarily
-- excluded from THIS campaign's send so a likely-unsubscriber is given a
-- cooling-off window instead of another email that pushes them to churn.
--
-- This table records one row per temporary exclusion: which subscriber was
-- held back, for which campaign, why, and WHEN the cooling-off window expires
-- (re-entry). A scheduler / the next refine pass treats rows past expires_at
-- as inactive so the subscriber automatically re-enters the eligible pool —
-- the same 24h-style cooling-off re-entry pattern resend_unopened.go uses.
--
-- Design notes:
--   * (tenant_id, subscriber_id, campaign_id) is unique so a re-refine of the
--     same campaign is idempotent per member (ON CONFLICT bumps expires_at +
--     reason rather than stacking duplicate exclusion rows).
--   * campaign_id is a free uuid (NOT a FK) because campaigns live in the
--     Listmonk engine, not this Postgres mirror; the refiner only needs a
--     stable correlation id for the send cycle.
--   * reason is a short machine code ('churn_risk' | 'recently_paused' |
--     'manual') the preview + UI surface; pinned via CHECK so a drifting
--     client cannot land an unknown value.
--   * churn_score_at_exclusion snapshots the score that triggered the hold so
--     the explainability preview can show "excluded at churn 87" even after
--     the cached score later moves.
--   * expires_at is the cooling-off re-entry instant. NULL = no auto re-entry
--     (held until the next refine pass clears it). The composite index on
--     (tenant_id, campaign_id, expires_at) is the send-path lookup
--     ("active exclusions for this campaign right now").
--
-- RLS uses the project's standard
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid idiom.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_send_exclusions (
    id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id            uuid        NOT NULL,
    campaign_id              uuid        NOT NULL,
    reason                   text        NOT NULL DEFAULT 'churn_risk'
        CHECK (reason IN ('churn_risk', 'recently_paused', 'manual')),
    churn_score_at_exclusion integer     NOT NULL DEFAULT 0
        CHECK (churn_score_at_exclusion >= 0 AND churn_score_at_exclusion <= 100),
    expires_at               timestamptz,
    created_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, subscriber_id, campaign_id)
);

-- Send-path lookup: "active exclusions for this campaign as of now()" —
-- the composite keeps the gate query off a seq scan.
CREATE INDEX IF NOT EXISTS subscriber_send_exclusions_campaign_idx
    ON subscriber_send_exclusions (tenant_id, campaign_id, expires_at);

-- Re-entry sweep: rows whose cooling-off window has elapsed.
CREATE INDEX IF NOT EXISTS subscriber_send_exclusions_expiry_idx
    ON subscriber_send_exclusions (tenant_id, expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_send_exclusions TO postwave_app;

ALTER TABLE subscriber_send_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_send_exclusions FORCE  ROW LEVEL SECURITY;

CREATE POLICY subscriber_send_exclusions_select ON subscriber_send_exclusions
    FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_send_exclusions_insert ON subscriber_send_exclusions
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_send_exclusions_update ON subscriber_send_exclusions
    FOR UPDATE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY subscriber_send_exclusions_delete ON subscriber_send_exclusions
    FOR DELETE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

COMMIT;
