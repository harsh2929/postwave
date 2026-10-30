-- 1908_tenant_exports_retention_delete.sql
--
-- Expired tenant exports were never purged.
--
-- `retention.Sweeper.sweepExports` selects exports past their retention window,
-- deletes the stored artefacts, and then deletes the rows:
--
--     DELETE FROM tenant_exports WHERE tenant_id = $1 AND id = ANY($2)
--
-- The sweeper is built in main.go with the application `pool` and runs as
-- `postwave_app`, which holds no DELETE on this table. Every sweep raised
-- `permission denied for table tenant_exports`. Verified by attempting exactly
-- that delete as the app role.
--
-- So a table of export requests — each one a record that somebody pulled an
-- audience out of the product — grows without bound, and the retention window
-- the product commits to is not enforced. Same class as the audit-log trimmer
-- (1902): a compliance job that runs, fails on the write it exists to perform,
-- and leaves the data in place.
--
-- THE GRANT IS PAIRED WITH A CAPABILITY, as it was for audit_log. The existing
-- `tenant_visible` policy is PERMISSIVE FOR ALL and already admits the tenant,
-- so a bare DELETE grant would let ANY ordinary tenant-scoped request delete its
-- own export history — including the record that an export happened. That is a
-- worse property than the bug: an export row is evidence.
--
-- A RESTRICTIVE DELETE policy fixes the direction. Restrictive policies AND with
-- the permissive ones, so a delete now needs the tenant match `tenant_visible`
-- already demands AND the retention capability. Ordinary request paths never set
-- that GUC; the sweeper does.
--
-- `app.retention_worker` is the capability this schema already uses for exactly
-- this purpose — see the DELETE policy on `outbound_webhook_event_receipts`,
-- which the webhook sweep presents today. Reusing it rather than inventing a
-- second name keeps "may purge on a retention schedule" one idea.

BEGIN;

GRANT DELETE ON tenant_exports TO postwave_app;

DROP POLICY IF EXISTS tenant_exports_retention_delete_only ON tenant_exports;
CREATE POLICY tenant_exports_retention_delete_only ON tenant_exports
    AS RESTRICTIVE
    FOR DELETE
    USING (current_setting('app.retention_worker', true) = 'true');

COMMENT ON POLICY tenant_exports_retention_delete_only ON tenant_exports IS
    'Export rows may only be deleted by the retention sweep, which sets '
    'app.retention_worker. RESTRICTIVE so it ANDs with tenant_visible: an '
    'ordinary tenant request satisfies that permissive policy but not this one, '
    'so a tenant cannot erase the record that an export happened. The DELETE '
    'grant exists only to make the sweep possible — without it every sweep '
    'raised "permission denied for table tenant_exports" and expired exports '
    'were never purged.';

COMMIT;
