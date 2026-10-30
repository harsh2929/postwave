-- 0399_sequence_enrollments.sql
--
-- Enrollment + goal-completion tracking for voice sequences, and the
-- table the external dispatcher consults to honour exit_on_goal.
--
-- WHY: voice_sequences.goal (migration 0395) stores a sequence-level
-- success criterion {kind: open|click|conversion, exit_on_goal: bool}.
-- In-repo we can derive open/click goal-completion from
-- sequence_funnel_events (see services/voice GoalMet), but that is a
-- READ-TIME derivation over funnel facts — there is no durable, queryable
-- "this subscriber completed the goal at T" record, and no place for the
-- external send dispatcher to cheaply ask "has this subscriber met the
-- goal so I should skip the next step?". This table is that record.
--
-- One row per (tenant, sequence, subscriber). enrolled_at is set when the
-- subscriber first appears in the sequence; completed_goal_at /
-- completed_goal_kind are filled (idempotently, earliest-wins) when an
-- open/click goal is observed.
--
-- WRITERS:
--   * The open/click -> goal-completion upsert in
--     apps/api/internal/listmonk_events. This is a GUARDED no-op today:
--     inbound open/click events carry NO sequence attribution (verified
--     2026-06-13 — neither the Listmonk webhook payload nor the
--     campaigns / subscriber_events / campaign_report_events tables link
--     a campaign back to a sequence_id + position), so the handler has
--     nothing to key an enrollment on. The write path is wired and
--     commented so it activates the moment the engine attaches
--     sequence_id+position to sends (see the engine contract doc).
--   * The external sequence dispatcher SHOULD upsert enrolled_at on each
--     send (so enrollment exists even before any open/click) and MAY
--     stamp completed_goal_at itself for conversion goals it observes.
--
-- READERS:
--   * GET /v1/voice/sequences/{id}/goal-progress (services/voice)
--     surfaces enrolled / goal-completed counts.
--   * The external dispatcher, BEFORE sending a step, runs (for a
--     sequence whose goal.exit_on_goal is true):
--
--       SELECT 1 FROM sequence_enrollments
--        WHERE tenant_id = $1 AND sequence_id = $2
--          AND subscriber_email = $3 AND completed_goal_at IS NOT NULL;
--
--     and skips the send when a row is found. The exact query + the
--     full stamping contract live in
--     apps/desktop/SEQUENCE-LOOP-ENGINE-CONTRACT.md.
--
-- RLS: tenant isolation via the NULLIF tenant-GUC idiom (a raw cast
-- crashes on an unset app.tenant_id). A RESTRICTIVE gate admits the
-- outbox/worker scope on the READ side only (so the cross-tenant
-- enumeration the dispatcher-side scanner / goal-progress worker may run
-- under db.WithWorkerScope can SELECT), while WITH CHECK stays
-- tenant-only so worker scope without a bound tenant can read but never
-- write. This mirrors feed_sources (0384) / audience_syncs (0376) and
-- does NOT reintroduce the RLS-dead-worker bug: the worker enumerates
-- under app.outbox_worker='true', then re-binds app.tenant_id per
-- sequence for every per-tenant read/write.

BEGIN;

CREATE TABLE IF NOT EXISTS sequence_enrollments (
    id                  bigserial PRIMARY KEY,
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- references voice_sequences(id) but no FK so historical sequences
    -- survive a sequence delete (mirrors sequence_funnel_events, 0052).
    sequence_id         uuid NOT NULL,
    subscriber_email    citext NOT NULL,
    enrolled_at         timestamptz NOT NULL DEFAULT now(),
    -- Goal completion. NULL until an open/click goal is observed (or the
    -- dispatcher stamps a conversion). Earliest-wins on upsert.
    completed_goal_at   timestamptz,
    -- The goal kind that was met: 'open' | 'click' | 'conversion'.
    completed_goal_kind text CHECK (
        completed_goal_kind IS NULL
        OR completed_goal_kind IN ('open', 'click', 'conversion')
    ),
    UNIQUE (tenant_id, sequence_id, subscriber_email)
);

-- Per-sequence enumeration + the dispatcher's exit_on_goal lookup both
-- filter on (tenant_id, sequence_id); the partial expression keeps the
-- "who has completed the goal?" scan cheap.
CREATE INDEX IF NOT EXISTS sequence_enrollments_tenant_seq_idx
    ON sequence_enrollments (tenant_id, sequence_id);

CREATE INDEX IF NOT EXISTS sequence_enrollments_completed_idx
    ON sequence_enrollments (tenant_id, sequence_id)
    WHERE completed_goal_at IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON sequence_enrollments TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE sequence_enrollments_id_seq TO postwave_app;

ALTER TABLE sequence_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_enrollments FORCE  ROW LEVEL SECURITY;

-- RESTRICTIVE gate, ANDed on top of the permissive policies below
-- (the 0325 lesson, applied up-front like 0384). The read side admits
-- worker scope; WITH CHECK stays tenant-only so worker scope without a
-- bound tenant can read but never insert/update enrollments.
CREATE POLICY tenant_isolation ON sequence_enrollments
    AS RESTRICTIVE FOR ALL
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Permissive tenant policy for request paths (db.WithTenant / the
-- per-tx app.tenant_id GUC the voice + api stores set).
CREATE POLICY tenant_visible ON sequence_enrollments
    AS PERMISSIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Cross-tenant SELECT under db.WithWorkerScope (app.outbox_worker =
-- 'true'), mirroring feed_sources_worker_select (0384). Any worker that
-- enumerates enrollments re-binds app.tenant_id per row before writing,
-- so all writes still flow through the tenant policies.
CREATE POLICY sequence_enrollments_worker_select ON sequence_enrollments
    AS PERMISSIVE FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
