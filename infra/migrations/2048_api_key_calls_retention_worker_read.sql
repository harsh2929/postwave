-- 2048_api_key_calls_retention_worker_read.sql
--
-- The api_key_calls retention sweep has deleted nothing since 1725 added it,
-- and the DELETE grant 1725 added for it reaches further than the sweep.
--
-- 1. The sweep could not see the rows it was meant to delete.
--
--    apikeycalls.Repo.PurgeOlderThan, run hourly by apikeycalls.Sweeper
--    (started from main.go), deletes expired rows with no tenant bound:
--
--      DELETE FROM api_key_calls
--       WHERE id IN (SELECT id FROM api_key_calls
--                     WHERE called_at < $1 ORDER BY id LIMIT $2)
--
--    1725 granted DELETE and created api_key_calls_worker_retention_delete, a
--    worker DELETE policy, but no worker SELECT policy. Under row-level
--    security a DELETE whose WHERE reads the table's columns sees only the
--    rows a SELECT (or ALL) policy admits, and the subquery is a plain SELECT.
--    The only other policy, api_key_calls_tenant_isolation, admits no row when
--    no tenant is bound. So every tick found no row and returned 0, and call
--    records (paths, query strings, request-body summaries, remote IPs)
--    outlived POSTWAVE_API_KEY_CALLS_RETENTION_DAYS indefinitely.
--
-- 2. Every tenant-scoped session could delete its own call records.
--
--    api_key_calls_tenant_isolation is PERMISSIVE FOR ALL, so 1725's bare
--    DELETE grant also let any tenant-scoped transaction delete that tenant's
--    rows, although the table is append-only for tenant requests. This is the
--    shape 1909 closed on webhook_deliveries.
--
-- The repair follows the retention pattern of 1909 and 2037: a cross-tenant
-- path, and the DELETE grant, are opened only to the retention capability.
-- PurgeOlderThan now sets app.retention_worker as well as app.outbox_worker,
-- transaction-locally (db.WithWorkerScope, then set_config(..., true)), and it
-- is the only code that reads or deletes this table without binding a tenant.
--
--   * api_key_calls_retention_worker_select (new) lets the sweep find expired
--     rows in every tenant. SELECT-only, and only for the retention
--     capability: app.outbox_worker and app.retention_worker.
--   * api_key_calls_retention_delete_only (new) is RESTRICTIVE, so it ANDs
--     with every permissive policy: a row may be deleted only when
--     app.retention_worker is set. Together with 1725's worker DELETE policy
--     (app.outbox_worker), which it leaves as it is, a delete across tenants
--     needs both settings, as the SELECT above does. A tenant session keeps
--     reading and inserting its own rows exactly as before and deletes none.
--
-- Tenant deletion still removes a tenant's call records: the ON DELETE
-- CASCADE from tenants runs as a referential action, which row-level security
-- does not filter.
--
-- apps/api/internal/apikeycalls/repo_db_test.go runs the purge as
-- postwave_app with no tenant bound (TestRepo_PurgeOlderThan_DeletesOldOnly,
-- TestRepo_PurgeOlderThan_ReachesEveryTenant); both fail without the SELECT
-- policy. TestCrossTenantCallRecordsNeedTheRetentionCapability pins the rest:
-- a plain worker scope, app.retention_worker on its own and another tenant's
-- session each read and delete none of a tenant's rows, and the tenant's own
-- session deletes none either.
--
-- migration-execution: transactional
-- rollback-strategy: no-op
-- rollback-details: Keep both policies when a previous application image
-- is restored. That image's sweep sets only app.outbox_worker, so it still
-- finds no row, exactly as before this migration, and no image deletes call
-- records in tenant scope. Dropping them would stop api_key_calls retention
-- for the current image and reopen tenant-scoped deletes.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS api_key_calls_retention_worker_select ON public.api_key_calls;
CREATE POLICY api_key_calls_retention_worker_select ON public.api_key_calls
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (
        COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
        AND COALESCE(current_setting('app.retention_worker', true), '') = 'true'
    );

DROP POLICY IF EXISTS api_key_calls_retention_delete_only ON public.api_key_calls;
CREATE POLICY api_key_calls_retention_delete_only ON public.api_key_calls
    AS RESTRICTIVE
    FOR DELETE
    USING (current_setting('app.retention_worker', true) = 'true');

COMMENT ON POLICY api_key_calls_retention_worker_select ON public.api_key_calls IS
    'Lets the retention sweep (apikeycalls.Repo.PurgeOlderThan: app.outbox_worker '
    'and app.retention_worker, no tenant bound) find expired rows in every tenant. '
    'The DELETE policy alone does not: a DELETE whose WHERE reads columns sees only '
    'rows a SELECT policy admits. SELECT-only; tenant sessions are unaffected.';

COMMENT ON POLICY api_key_calls_retention_delete_only ON public.api_key_calls IS
    'Call records may only be deleted by the retention sweep, which sets '
    'app.retention_worker. RESTRICTIVE so it ANDs with api_key_calls_tenant_isolation: '
    'the table stays append-only for tenant sessions, while the scheduled purge can '
    'delete. Tenant deletion cascades as a referential action, which RLS does not filter.';

COMMIT;
