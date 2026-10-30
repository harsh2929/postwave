-- 1961_engagement_stage_two_evaluation.sql
--
-- Track B F01 Stage 2: the DELAYED re-evaluation schedule.
--
-- WHY THIS TABLE EXISTS
-- Stage 1 classifies an engagement event the instant it arrives, on the
-- evidence that exists at that instant.  For the FIRST event of a message that
-- evidence is one row: one open, no siblings, no delivery time.  A single open
-- looks human.  Forty identical opens two hundred milliseconds apart do not —
-- but nothing about the fortieth open is visible when the first one lands.
--
-- Stage 2 is therefore a SCHEDULER, not a second classifier.  It re-runs the
-- existing methodology over the existing message aggregate once the SHAPE of
-- the traffic has had time to appear.  The PRD names two moments:
--   * 'delayed'                 — 60 seconds after the FIRST event of a message
--   * 'conversion_window_close' — at the close of the attribution window
--
-- WHY THE ROW IS KEYED ON (tenant, message, stage) AND NEVER MOVES
-- One row per message per stage, inserted ON CONFLICT DO NOTHING by whichever
-- event arrives first.  That single fact is what stops a busy message from
-- re-arming its own timer: a message receiving 400 opens schedules ONE delayed
-- evaluation, due 60s after the first of them, not 400 evaluations nor one that
-- keeps sliding into the future and never fires.  due_at and first_event_at are
-- made immutable by the guard trigger below so no later writer can move them —
-- an app-side ON CONFLICT DO UPDATE would otherwise silently reintroduce the
-- sliding timer, and RLS filters rather than refuses, so the invariant is
-- enforced where it cannot be bypassed.
--
-- WHY THERE IS NO LEASE ON THIS TABLE
-- Mutual exclusion between workers already exists on event_reclassification_runs
-- (fenced token, attempt counter, steal-refusing trigger).  Stage 2 claims a run
-- whose request_id is DERIVED deterministically from (tenant, message, stage),
-- so two workers reaching the same due message contend for the same run row and
-- exactly one wins; the loser is told the run is in progress and does nothing.
-- Adding a second, independent lease here would create two sources of truth
-- about who owns a message and a way for them to disagree.
--
-- rollback-strategy: no-op. The table is additive scheduling state over the
-- append-only F01 evidence ledgers; every verdict Stage 2 produces is a normal
-- event_classifications row with supersedes_id lineage. An older binary simply
-- stops scheduling and stops draining; no evidence is lost and nothing already
-- written becomes unreadable.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE engagement_stage_two_evaluations (
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The message identity is already a tenant-scoped keyed commitment; the raw
    -- Message-ID never reaches this table.
    message_identity_hash text NOT NULL CHECK (
                              message_identity_hash ~ '^[0-9a-f]{64}$'
                          ),
    stage                 text NOT NULL CHECK (
                              stage IN ('delayed', 'conversion_window_close')
                          ),
    -- occurred_at of the first event OBSERVED for this message. Provider clocks
    -- are honoured: a replayed week-old event is due immediately, which is
    -- correct, because its message shape is already complete.
    first_event_at        timestamptz NOT NULL,
    due_at                timestamptz NOT NULL,
    state                 text NOT NULL DEFAULT 'pending' CHECK (
                              state IN ('pending', 'completed', 'failed')
                          ),
    -- The reclassification run that actually performed the evaluation. This is
    -- the audit edge from "we decided to look again" to the fenced worker,
    -- lease, and appended verdicts that resulted.
    run_id                uuid,
    evaluated_event_count bigint NOT NULL DEFAULT 0 CHECK (evaluated_event_count >= 0),
    superseded_count      bigint NOT NULL DEFAULT 0 CHECK (superseded_count >= 0),
    unchanged_count       bigint NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
    error_code            text CHECK (
                              error_code IS NULL OR
                              error_code ~ '^[a-z][a-z0-9_.-]{0,95}$'
                          ),
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at          timestamptz,
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),

    PRIMARY KEY (tenant_id, message_identity_hash, stage),
    CONSTRAINT engagement_stage_two_evaluations_run_fk
        FOREIGN KEY (tenant_id, run_id)
        REFERENCES event_reclassification_runs (tenant_id, id)
        ON DELETE CASCADE,
    -- A schedule whose due time is not strictly after the anchoring event is not
    -- a delay; it is an immediate re-run of Stage 1 on Stage 1's evidence.
    CONSTRAINT engagement_stage_two_evaluations_delay_check CHECK (
        due_at > first_event_at
    ),
    CONSTRAINT engagement_stage_two_evaluations_terminal_shape CHECK (
        (state = 'pending' AND completed_at IS NULL AND error_code IS NULL
            AND run_id IS NULL AND evaluated_event_count = 0
            AND superseded_count = 0 AND unchanged_count = 0)
        OR
        (state = 'completed' AND completed_at IS NOT NULL AND error_code IS NULL
            AND run_id IS NOT NULL
            AND superseded_count + unchanged_count = evaluated_event_count)
        OR
        (state = 'failed' AND completed_at IS NOT NULL AND error_code IS NOT NULL)
    )
);

-- The drain query is "pending and due, oldest first, within one tenant". The
-- partial index keeps completed history out of the hot path entirely.
CREATE INDEX engagement_stage_two_evaluations_due_idx
    ON engagement_stage_two_evaluations (tenant_id, due_at, message_identity_hash)
    WHERE state = 'pending';

COMMENT ON TABLE engagement_stage_two_evaluations IS
    'F01 Stage-2 schedule: one row per (tenant, message, stage). due_at is immutable, so a busy message re-evaluates once at 60s after its FIRST event and once at conversion-window close, never continuously.';
COMMENT ON COLUMN engagement_stage_two_evaluations.due_at IS
    'Immutable. Set from the first observed event only; later events for the same message never move it.';
COMMENT ON COLUMN engagement_stage_two_evaluations.run_id IS
    'The fenced event_reclassification_runs row that performed this evaluation; the lease lives there, not here.';

CREATE OR REPLACE FUNCTION engagement_stage_two_evaluation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- Depth > 1 is the tenant/run ON DELETE CASCADE, which is legitimate.
        IF pg_trigger_depth() > 1 THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'engagement stage two evaluations cannot be deleted directly'
            USING ERRCODE = '55000';
    END IF;
    -- The schedule identity, and above all the DUE TIME, is fixed at insert.
    -- This is the invariant that makes "60s after the FIRST event" true rather
    -- than "60s after the most recent event", and it is enforced here because a
    -- policy cannot express it and an application ON CONFLICT clause is one
    -- edit away from reintroducing the sliding timer.
    IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.message_identity_hash IS DISTINCT FROM NEW.message_identity_hash
       OR OLD.stage IS DISTINCT FROM NEW.stage
       OR OLD.first_event_at IS DISTINCT FROM NEW.first_event_at
       OR OLD.due_at IS DISTINCT FROM NEW.due_at
       OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'engagement stage two schedule identity is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.state IN ('completed', 'failed') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'terminal engagement stage two evaluation is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state
       AND NOT (OLD.state = 'pending' AND NEW.state IN ('completed', 'failed')) THEN
        RAISE EXCEPTION 'invalid engagement stage two transition: % -> %',
            OLD.state, NEW.state USING ERRCODE = '55000';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER engagement_stage_two_evaluations_guard
    BEFORE UPDATE OR DELETE ON engagement_stage_two_evaluations
    FOR EACH ROW EXECUTE FUNCTION engagement_stage_two_evaluation_guard();

GRANT SELECT, INSERT, UPDATE ON engagement_stage_two_evaluations TO postwave_app;
REVOKE DELETE, TRUNCATE ON engagement_stage_two_evaluations FROM postwave_app;

ALTER TABLE engagement_stage_two_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_stage_two_evaluations FORCE ROW LEVEL SECURITY;

-- Row security FILTERS; it does not refuse. Every command the grant allows
-- (SELECT, INSERT, UPDATE) therefore needs its own policy, or the statement
-- matches zero rows and reports success. The scope is the same two-factor
-- classifier-worker scope every other F01 evidence table requires: a plain
-- tenant session can neither read nor arm an evaluation.
CREATE POLICY engagement_stage_two_evaluations_worker_select
    ON engagement_stage_two_evaluations FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );
CREATE POLICY engagement_stage_two_evaluations_worker_insert
    ON engagement_stage_two_evaluations FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );
CREATE POLICY engagement_stage_two_evaluations_worker_update
    ON engagement_stage_two_evaluations FOR UPDATE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );

COMMIT;
