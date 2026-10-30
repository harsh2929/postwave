-- 1902_audit_log_trim_capability.sql
--
-- Audit-log retention never trimmed anything.
--
-- `audit.Trimmer` runs on the main application pool (see
-- `workers/data_retention.go` → `Pool: deps.Pool`, wired from main.go), which
-- connects as `postwave_app`. That role holds INSERT and SELECT on `audit_log`
-- and NOT DELETE, so the bounded delete at the heart of the trimmer raised
--
--     ERROR: permission denied for table audit_log
--
-- every time it ran. The audit log grows without bound and the retention window
-- the product promises is not enforced.
--
-- THE CAPABILITY WAS ALREADY DESIGNED, AND NOTHING READ IT. `trim.go` sets
-- `app.audit_trim_worker = 'true'` on its transactions — twice — and no policy
-- anywhere in the schema mentions that GUC (checked: zero references). The
-- intent was clearly a capability-gated delete; only the half that enforces it
-- was missing.
--
-- Granting DELETE alone would be wrong. `tenant_isolation` on audit_log is
-- PERMISSIVE FOR ALL, so a bare grant would let ANY ordinary tenant-scoped
-- request delete its own audit rows — which destroys the immutability the audit
-- log exists to provide, and would be a far worse bug than the one being fixed.
--
-- So the grant is paired with a RESTRICTIVE policy. Restrictive policies AND
-- with the permissive ones, so a delete now requires BOTH the tenant match that
-- `tenant_isolation` already demands AND the trim-worker capability. Ordinary
-- request paths never set that GUC and so still cannot delete an audit row;
-- the trimmer sets it and can.
--
-- Same shape as the retention gate already used on
-- `outbound_webhook_event_receipts`, which requires `app.retention_worker`.

BEGIN;

GRANT DELETE ON audit_log TO postwave_app;
GRANT DELETE ON audit_log_legacy TO postwave_app;

DROP POLICY IF EXISTS audit_log_trim_worker_only ON audit_log;
CREATE POLICY audit_log_trim_worker_only ON audit_log
    AS RESTRICTIVE
    FOR DELETE
    USING (current_setting('app.audit_trim_worker', true) = 'true');

DROP POLICY IF EXISTS audit_log_legacy_trim_worker_only ON audit_log_legacy;
CREATE POLICY audit_log_legacy_trim_worker_only ON audit_log_legacy
    AS RESTRICTIVE
    FOR DELETE
    USING (current_setting('app.audit_trim_worker', true) = 'true');

COMMENT ON POLICY audit_log_trim_worker_only ON audit_log IS
    'Audit rows may only be deleted by the retention trimmer, which sets '
    'app.audit_trim_worker. RESTRICTIVE so it ANDs with tenant_isolation: an '
    'ordinary tenant request satisfies that permissive policy but not this one, '
    'so the log stays immutable outside retention. The DELETE grant exists only '
    'to make the trimmer possible at all — without it every trim raised '
    '"permission denied for table audit_log".';

COMMIT;
