-- 0154_misc_table_app_grants.sql
--
-- Same forward-fix shape as 0153: seven additional tables were
-- created in earlier migrations without GRANTing app-role access.
-- Each is queried from inside apps/api/internal/* under the
-- postwave_app connection, so any read/write would fail with
-- "permission denied for table … (SQLSTATE 42501)" once the
-- relevant code path runs (typically a worker tick, scheduled job,
-- or an admin/deliverability dashboard call).
--
-- Tenant isolation (where applicable) is still enforced by the
-- per-table RLS policy; the GRANT only opens DML to the role.
-- Tables without tenant_id (e.g. dmarc_aggregate_* per-domain
-- aggregates ingested out-of-band) rely on application logic for
-- access control.

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON blocklist_observations    TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON dmarc_aggregate_records   TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON dmarc_aggregate_reports   TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON service_health_pings      TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sunset_executions         TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sunset_policies           TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON winback_candidate_queue   TO postwave_app;

COMMIT;
