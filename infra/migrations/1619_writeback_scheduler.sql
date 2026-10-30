-- 1619_writeback_scheduler.sql
--
-- Continuous (scheduled) write-back. Klaviyo-class integrations sync two-way on
-- their own, not on a manual button-press. sync_interval_minutes > 0 opts a
-- target into the background scheduler, which scans cross-tenant for due targets
-- (last_run_at older than the interval) under the worker scope and runs each one
-- under its own tenant RLS.

ALTER TABLE writeback_targets
    ADD COLUMN IF NOT EXISTS sync_interval_minutes integer NOT NULL DEFAULT 0;

-- Cross-tenant SELECT for the scheduler's due-scan (app.outbox_worker GUC),
-- mirroring the audience_syncs / *_worker_select pattern. Read-only; each due
-- target then executes under its own app.tenant_id scope.
DROP POLICY IF EXISTS writeback_targets_worker_select ON writeback_targets;
CREATE POLICY writeback_targets_worker_select ON writeback_targets
    AS PERMISSIVE FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');
