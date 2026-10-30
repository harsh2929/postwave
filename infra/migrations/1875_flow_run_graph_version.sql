-- 1875_flow_run_graph_version.sql
--
-- Record WHICH graph a run is executing.
--
-- A flow is a program, and `automation_flow_versions` already stores each
-- published version of it — the whole graph, as jsonb. What no run recorded is
-- which of those versions it enrolled under. So:
--
--   * An operator edits a live flow. Runs enrolled yesterday are mid-journey.
--     Did they finish the graph they started, or switch to the new one at their
--     next step? The rows cannot say, and the two answers produce different
--     emails for the same person.
--
--   * A run misbehaves and someone asks "what did this flow look like when that
--     happened". The flow's current graph is the wrong answer whenever the flow
--     has been edited since, which for an active flow is most of the time.
--
--   * A/B results, step metrics and conversion attribution are all aggregated
--     across runs that may have followed structurally different graphs, with
--     nothing to group or exclude by.
--
-- FK'd to the version row rather than copying the graph: the graph is already
-- stored once and duplicating it per run would be both large and a second
-- source of truth about what the flow said.
--
-- NULLABLE and un-backfilled. Existing runs enrolled before this column
-- existed, and their version is genuinely unknown — inventing one (the current
-- version, say) would assert exactly the thing this column exists to stop
-- guessing at. NULL reads as "unknown", which is honest.
--
-- ON DELETE RESTRICT: a version a run points at must not vanish while the run
-- can still be inspected. Deleting the evidence out from under a completed run
-- is how you get a history nobody can explain.

BEGIN;

ALTER TABLE flow_runs
    ADD COLUMN IF NOT EXISTS graph_version_id uuid
        REFERENCES automation_flow_versions(id) ON DELETE RESTRICT;

-- DELIBERATELY NOT automation_executions.
--
-- An earlier draft of this migration added the same column there. Verifying
-- before building the writer showed it could never be populated:
-- `automation_executions` is owned by services/automation and its
-- `automation_id` points at `automations`, a table with NO relationship to
-- `automation_journeys` — which is what `automation_flow_versions.journey_id`
-- references. They are two different automation models in two different
-- services, and the FK linked one's runs to the other's versions.
--
-- So the column was unfillable by construction: nothing could ever have written
-- a valid value, and it would have sat as a permanently-NULL field implying a
-- provenance that does not exist. Removed rather than left as scaffolding, which
-- is the failure this column was added to fix in the first place.
--
-- If that service ever needs run-to-version provenance it needs its OWN
-- versions table, not a foreign key into the flow builder's.

COMMENT ON COLUMN flow_runs.graph_version_id IS
    'The automation_flow_versions row this run enrolled under — the exact graph '
    'it is executing. Stamped at enrollment so an edit to the flow afterwards '
    'cannot change what this run is understood to have followed. NULL for runs '
    'that predate the column, where the version is genuinely unknown.';

-- Inspecting "every run of version X" is the question this column exists to
-- answer; without an index it is a sequential scan of a per-tenant run table.
CREATE INDEX IF NOT EXISTS flow_runs_graph_version_idx
    ON flow_runs (tenant_id, graph_version_id)
 WHERE graph_version_id IS NOT NULL;

COMMIT;
