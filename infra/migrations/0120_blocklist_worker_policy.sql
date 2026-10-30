-- 0120_blocklist_worker_policy.sql
--
-- Hotfix follow-up to 0112: the blocklist monitor writes ACROSS
-- tenants (it sweeps every tenant's IPs / domains in one pass) and
-- runs under the regular postwave_app role with `app.outbox_worker`
-- = 'true'. The original 0112 only created a tenant-isolation policy
-- which rejects every cross-tenant write the worker tries to make:
-- INSERTs of tenant-bound observations FAIL because the WITH CHECK
-- requires either NULL tenant_id or a matching app.tenant_id (which
-- the worker doesn't set).
--
-- This migration adds the worker-permissive policy. Same pattern as
-- outbound_webhooks (migration 0088), dedicated_ip_assignments
-- (0114), and blocklist_suppressions (0113).
--
-- The AutoSuppressSweep also relies on this; without it the sweep
-- query returns zero rows because RLS hides everything.

BEGIN;

DROP POLICY IF EXISTS blocklist_observations_worker_all ON blocklist_observations;
CREATE POLICY blocklist_observations_worker_all ON blocklist_observations
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
