-- 1706_flow_runs_trigger_payload.sql
--
-- flow_runs is the queue that tag_added / tag_removed / list_joined /
-- zero-copy-warehouse triggers write into. It has had three producers and NO
-- CONSUMER: `grep -rn "flow_runs" services/ packages/` returned nothing, and
-- the only reader was a UI list endpoint. Rows were inserted at status='queued'
-- and stayed there forever, so those triggers never fired. The module's own doc
-- comment claims "the automation service drains the queue". It did not.
--
-- Draining it needs one thing the table never stored: the trigger's PAYLOAD.
-- Engine.Trigger re-checks the payload against the flow's trigger spec
-- (triggerMatches: a trigger with Tag="vip" only fires when payload["tag"] ==
-- "vip"), so a drained run carrying no payload would be silently rejected as a
-- non-match — swapping one silent no-op for another.
--
-- The producer already knows the tag / list at enqueue time; it simply threw it
-- away. Persist it.

ALTER TABLE flow_runs
    ADD COLUMN IF NOT EXISTS trigger_payload jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN flow_runs.trigger_payload IS
    'Trigger match context (e.g. {"tag":"vip"} or {"list_id":"..."}). Required by the drainer: Engine.Trigger re-checks the payload against the flow''s trigger spec, so an empty payload would be rejected as a non-match.';

-- The drainer claims with FOR UPDATE SKIP LOCKED on (status, scheduled_at), so
-- it can run on every replica without double-firing a flow.
--
-- CONCURRENTLY: flow_runs is written on every tag apply / list join, so a plain
-- CREATE INDEX would take an ACCESS EXCLUSIVE lock and block those writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS flow_runs_claim_idx
    ON flow_runs (status, scheduled_at)
    WHERE status = 'queued';
