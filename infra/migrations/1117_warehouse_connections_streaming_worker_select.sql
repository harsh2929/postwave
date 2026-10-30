-- 1117_warehouse_connections_streaming_worker_select.sql
--
-- SUB-111 — Currents-style streaming export, scheduled-worker enablement.
--
-- The streaming-export worker (apps/api/internal/streaming_export/worker.go)
-- runs an hourly tick that must first enumerate WHICH tenants own an
-- active streaming-export connection, then re-enter per-tenant scope to
-- ship each due window. The enumeration
-- (Repo.StreamingExportTenants) is cross-tenant:
--
--     SELECT DISTINCT tenant_id FROM warehouse_connections
--      WHERE provider = 'streaming_export' AND status = 'active'
--
-- It runs under db.WithWorkerScope (binds app.outbox_worker = 'true'
-- transaction-locally). warehouse_connections (0207) is FORCE-RLS with a
-- tenant-gated RESTRICTIVE policy, so without a worker gate this scan
-- silently returns zero rows — the scheduled tick would never find any
-- connection and only the manual ShipNow path would work. This is the
-- same failure mode fixed for referral_conversions (0383),
-- audience_syncs_worker_select (0376), and agent_routines (0386).
--
-- warehouse_connections has BOTH policy kinds (0207):
--   * tenant_isolation (RESTRICTIVE) — ANDed on top of everything, so a
--     new permissive policy ALONE changes nothing (the 0325 lesson). We
--     re-create it with the worker GUC ORed into USING.
--   * tenant_visible (PERMISSIVE) — left as-is for request paths.
--
-- Write surface is intentionally NOT widened: the new permissive policy
-- is FOR SELECT only, and the restrictive policy's WITH CHECK stays
-- tenant-only, so worker scope without a bound tenant can read but never
-- insert/update/delete connection rows. Every worker write
-- (beginRun/completeRun on streaming_export_runs, and the per-tenant
-- ship path) goes through db.WithTenant and is unaffected. The read gate
-- only widens what the enumeration can SELECT; the rows it returns are
-- still re-shipped under a tenant-bound tx (tenant_isolation on
-- streaming_export_runs, migration 1100).
--
-- Tenant scoping + RLS shape copied from 0207 / 0383: every tenant-side
-- predicate reads the tenant via
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid so an unset
-- GUC does not crash the cast.
--
-- rollback-strategy: no-op — policy-only change. Previous releases never
-- relied on the worker gate (the cross-tenant scan simply returned zero
-- rows and the scheduled tick was a no-op), so leaving the policies in
-- place during a rollback is safe.

BEGIN;

-- Defensive no-ops: 0207 already enabled + forced RLS.
ALTER TABLE warehouse_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_connections FORCE  ROW LEVEL SECURITY;

-- Permissive worker read gate (mirrors audience_syncs_worker_select, 0376).
DROP POLICY IF EXISTS warehouse_connections_worker_select ON warehouse_connections;
CREATE POLICY warehouse_connections_worker_select ON warehouse_connections
    AS PERMISSIVE FOR SELECT
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

-- Widen the RESTRICTIVE gate's read side so the permissive policy above
-- can actually fire under worker scope (restrictive policies AND).
-- WITH CHECK deliberately stays tenant-only — see header comment.
DROP POLICY IF EXISTS tenant_isolation ON warehouse_connections;
CREATE POLICY tenant_isolation ON warehouse_connections
    AS RESTRICTIVE FOR ALL
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
