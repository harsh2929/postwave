-- 0042_abtests_scheduler_policy.sql
--
-- Permissive RLS policy for the A/B auto-promote scheduler. Mirrors
-- the pattern used by outbox_events (0035) and campaigns (0041): the
-- worker binds app.outbox_worker='true' before its SELECT, then
-- re-scopes app.tenant_id per matched row before any UPDATE.
--
-- We also need this on campaign_ab_settings because the scheduler's
-- find-due query JOINs against it. Without the policy the join
-- silently returns zero rows under the worker bypass.

BEGIN;

CREATE POLICY ab_settings_scheduler_select ON campaign_ab_settings
    AS PERMISSIVE
    FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
