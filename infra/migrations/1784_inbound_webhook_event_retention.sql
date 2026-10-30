-- 1784_inbound_webhook_event_retention.sql
--
-- Authenticated inbound webhook events retain transformed request bodies and
-- a deliberately minimized troubleshooting-header projection. Grant the
-- application role DELETE so the tenant-scoped retention sweeper can enforce
-- retention_policies.webhook_delivery_retention_days for these snapshots.

BEGIN;

GRANT DELETE ON inbound_events TO postwave_app;

COMMIT;
