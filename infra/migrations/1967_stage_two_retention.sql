-- 1967_stage_two_retention.sql
--
-- Retention for the Stage-2 SCHEDULE.
--
-- WHY THIS EXISTS
-- engagement_stage_two_evaluations accrues exactly two rows for every message
-- that ever carried an identity — one 'delayed', one 'conversion_window_close' —
-- and 1961 gave them no way out.  DELETE was revoked from postwave_app and the
-- guard trigger refuses a direct delete outright, so a completed schedule row is
-- immortal.  Every other evidence table in F01 is on a clock:
-- subscriber_event_observations is degraded at 90 days and purged at its privacy
-- expiry by the same retention sweep this package already runs.  The schedule was
-- the one table that only ever grew.
--
-- WHY DELETION IS THE RIGHT TIER HERE, UNLIKE OBSERVATIONS
-- An observation is EVIDENCE: delete it and no improved classifier can ever
-- revisit the event, which is why 1949 degrades rather than deletes.  A schedule
-- row is not evidence.  It records that a re-evaluation was DUE and which run
-- performed it; the verdicts themselves are event_classifications rows with
-- supersedes_id lineage, and the run is an event_reclassification_runs row with
-- its counters.  Both outlive this table.  Reaping a settled schedule row loses
-- the reminder, not the audit trail.
--
-- WHY ONLY TERMINAL ROWS, AND WHY THE TRIGGER RATHER THAN THE POLICY DECIDES
-- A pending row is an OWED evaluation.  Deleting one would cancel the 60-second
-- look or the conversion-window look for that message with no trace at all.  So
-- the exemption is granted only for rows that already reached 'completed' or
-- 'failed', and only while the retention worker declares itself through its own
-- GUC.
--
-- Both of those conditions are enforced in the TRIGGER, not in the policy, and
-- that split is deliberate.  Row security FILTERS: had the policy carried the
-- terminal-state and retention-worker predicates, a delete that violated either
-- would have matched zero rows and reported SUCCESS.  A worker bug aimed at a
-- pending row would look exactly like a tenant that had nothing to reap.  With
-- the predicates in the trigger the same statement RAISES.  The policy keeps the
-- job it can do honestly — tenant and worker scope, identical to the three
-- policies 1961 already defines — and the invariant that an owed evaluation
-- cannot vanish is asserted where even a superuser statement meets it.
--
-- WHAT RE-ARMING AFTER A REAP ACTUALLY DOES
-- A straggler event for a long-settled message re-INSERTs the schedule row (ON
-- CONFLICT DO NOTHING finds nothing) and re-arms an evaluation.  The re-inserted
-- row carries a NEW window: scheduleStageTwo sets first_event_at to the
-- straggler's observation time and due_at to first_event_at + StageTwoDelay.  A
-- Stage-2 run is keyed on that window — claimStageTwoRun reads the window out of
-- those two columns and stageTwoRunRequestID hashes it into the run id — so the
-- re-armed evaluation asks for a NEW run and classifies the message again over
-- the larger evidence set, which is how the straggler's own evidence receives a
-- Stage-2 verdict at all.  The reaped run stays completed and untouched, and no
-- already-appended verdict is duplicated: event_classifications is unique on the
-- classifier identity, so events whose verdict did not change are absorbed.
--
-- An earlier revision of this comment claimed the opposite — that the run id
-- "finds the ALREADY COMPLETED run and closes the new schedule row from its
-- counters without appending a single verdict".  That was false and is recorded
-- here rather than deleted, because the false version is the thing a reader of
-- an older checkout will have believed.  The run id at the time covered
-- (tenant, message, stage, classifier identity) but NOT the window, while
-- reclassificationRequestHash did cover the window, so the two disagreed on
-- exactly the axis a re-arm moves: createAndClaimRun found the old run under the
-- same id with a different request_hash and returned ErrIdempotencyConflict.
-- The re-armed row went terminal as failed/reclassification_request_conflict,
-- the straggler was never classified, the sweep reported success because
-- evaluate() returns a nil error on that branch, and because
-- event_reclassification_runs has no retention path the stale run outlived every
-- later re-arm.  The fix was to make the id cover the window too; see
-- stageTwoRunRequestID and
-- TestStageTwoReArmAfterAReapEvaluatesTheStragglerRatherThanConflicting_DB.
--
-- Reaping is bounded rather than aggressive for the same reason: the default
-- retention the worker applies is longer than the maximum conversion window, so
-- in practice both stages have settled long before a row is eligible.
--
-- rollback-strategy: no-op. Dropping the policy and restoring the trigger's
-- unconditional delete refusal returns the table to 1961's behaviour; nothing
-- already written becomes unreadable and no evidence table is touched.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

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
        -- The retention exemption. Terminal rows only, retention worker only.
        -- Asserted here rather than in the policy precisely so the two ways of
        -- getting it wrong — deleting an OWED evaluation, or deleting without
        -- declaring the retention worker — RAISE instead of quietly matching
        -- nothing and reporting success.
        IF current_setting('app.engagement_stage_two_retention_worker', true) = 'true'
           AND OLD.state IN ('completed', 'failed') THEN
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

GRANT DELETE ON engagement_stage_two_evaluations TO postwave_app;

-- The grant above is inert without a DELETE policy: row security would match
-- zero rows and report success. The scope is exactly the scope of the three
-- policies 1961 defines — tenant, outbox worker, classifier worker — and stops
-- there. The retention flag and the terminal-state requirement live in the
-- trigger so that violating either is an ERROR rather than a silent no-op.
DROP POLICY IF EXISTS engagement_stage_two_evaluations_retention_delete
    ON engagement_stage_two_evaluations;
CREATE POLICY engagement_stage_two_evaluations_worker_delete
    ON engagement_stage_two_evaluations FOR DELETE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );

COMMENT ON POLICY engagement_stage_two_evaluations_worker_delete
    ON engagement_stage_two_evaluations IS
    'Scope only. Whether a delete is ALLOWED — settled row, retention worker declared — is decided by engagement_stage_two_evaluation_guard, which refuses loudly instead of filtering silently.';

COMMIT;

-- The reap query is "terminal, oldest completion first, within one tenant".
-- Built CONCURRENTLY and outside the transaction so an existing deployment does
-- not take a write lock on the schedule while the sweep is running.
CREATE INDEX CONCURRENTLY IF NOT EXISTS engagement_stage_two_evaluations_retention_idx
    ON engagement_stage_two_evaluations (tenant_id, completed_at)
    WHERE state <> 'pending';
