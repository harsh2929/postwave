-- 1909_webhook_deliveries_retention_delete.sql
--
-- Expired inbound webhook deliveries were never purged.
--
-- `retention.Sweeper.sweepInboundWebhookDeliveries` selects deliveries past
-- their retention window and deletes them by ctid. The sweeper is built in
-- main.go with the application `pool` and runs as `postwave_app`, which holds
-- no DELETE on this table, so every sweep raised `permission denied for table
-- webhook_deliveries`. Verified by attempting exactly that delete as the app
-- role.
--
-- Delivery rows carry request and response bodies. A retention window that is
-- never enforced on them is not merely unbounded growth: it is third-party
-- payloads retained indefinitely after the point the product promised to drop
-- them.
--
-- Same shape and same capability as 1908 on `tenant_exports` and the existing
-- gate on `outbound_webhook_event_receipts`: the grant is paired with a
-- RESTRICTIVE DELETE policy requiring `app.retention_worker`, because
-- `tenant_isolation` here is PERMISSIVE FOR ALL and a bare grant would let any
-- ordinary tenant-scoped request delete its own delivery evidence. Restrictive
-- policies AND with the permissive ones, so a delete needs the tenant match it
-- already required AND the retention capability.

BEGIN;

GRANT DELETE ON webhook_deliveries TO postwave_app;

DROP POLICY IF EXISTS webhook_deliveries_retention_delete_only ON webhook_deliveries;
CREATE POLICY webhook_deliveries_retention_delete_only ON webhook_deliveries
    AS RESTRICTIVE
    FOR DELETE
    USING (current_setting('app.retention_worker', true) = 'true');

COMMENT ON POLICY webhook_deliveries_retention_delete_only ON webhook_deliveries IS
    'Delivery rows may only be deleted by the retention sweep, which sets '
    'app.retention_worker. RESTRICTIVE so it ANDs with tenant_isolation: a '
    'tenant cannot erase its own delivery evidence, while the scheduled purge '
    'can. Without the grant every sweep raised "permission denied" and request '
    'and response bodies were retained past the window the product promises.';

COMMIT;
