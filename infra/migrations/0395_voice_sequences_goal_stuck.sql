-- 0395_voice_sequences_goal_stuck.sql
--
-- FEATURE-ROADMAP-2026-06 voice-sequence follow-ups:
--
--   * `goal`            — optional sequence-level success criterion,
--                         jsonb {"kind": "conversion"|"click"|"open",
--                         "exit_on_goal": bool}. NULL = no goal. Open /
--                         click goals are evaluated in-repo from
--                         sequence_funnel_events; conversion goals are
--                         stored + exposed but have no in-repo event
--                         source yet (see generation.SequenceGoal).
--   * `stuck_after_days`— stuck-participant alert threshold. 0 (the
--                         default) disables detection for the sequence;
--                         1..365 enables both GET /sequences/{id}/stuck
--                         and the periodic stuck scanner worker.
--
-- The worker-select policy mirrors feed_sources_worker_select (0384) /
-- audience_syncs_worker_select (0376): the stuck scanner enumerates
-- sequences with stuck_after_days >= 1 across tenants under
-- db.WithWorkerScope (app.outbox_worker = 'true'), then re-binds
-- app.tenant_id per sequence for every actual read/emit, so all
-- per-tenant data access still flows through the tenant policies.
-- voice_sequences' original tenant_isolation policy (0010) is
-- PERMISSIVE, so adding a second permissive SELECT policy widens reads
-- for worker scope only; writes remain tenant-bound.

BEGIN;

ALTER TABLE voice_sequences
    ADD COLUMN IF NOT EXISTS goal jsonb,
    ADD COLUMN IF NOT EXISTS stuck_after_days int NOT NULL DEFAULT 0;

ALTER TABLE voice_sequences
    ADD CONSTRAINT voice_sequences_stuck_after_days_range
    CHECK (stuck_after_days BETWEEN 0 AND 365);

-- Partial index so the scanner's enumeration tick stays cheap: most
-- sequences never enable stuck detection.
CREATE INDEX voice_sequences_stuck_enabled_idx
    ON voice_sequences (tenant_id, id)
    WHERE stuck_after_days >= 1;

CREATE POLICY voice_sequences_worker_select ON voice_sequences
    AS PERMISSIVE FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
