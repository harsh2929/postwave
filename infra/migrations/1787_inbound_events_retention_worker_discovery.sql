-- 1787_inbound_events_retention_worker_discovery.sql
--
-- The consolidated retention worker discovers tenants before re-entering a
-- tenant-scoped transaction for each delete. inbound_events has FORCE RLS and
-- its original RESTRICTIVE tenant_isolation policy rejected that discovery
-- scan even when app.outbox_worker was transaction-locally bound. The result
-- was a silent retention failure: inbound payload rows could be deleted when a
-- tenant was known, but this table could never make that tenant known.
--
-- Permit only cross-tenant SELECT under the existing worker GUC. The
-- RESTRICTIVE policy must explicitly admit the worker for SELECT to be useful;
-- the separate PERMISSIVE policy supplies that command-specific grant.
-- INSERT, UPDATE and DELETE remain tenant-only because there is no worker
-- permissive policy for those commands and WITH CHECK remains unchanged.

BEGIN;

ALTER POLICY tenant_isolation ON inbound_events
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
    );

CREATE POLICY inbound_events_retention_worker_select ON inbound_events
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (COALESCE(current_setting('app.outbox_worker', true), '') = 'true');

COMMIT;
