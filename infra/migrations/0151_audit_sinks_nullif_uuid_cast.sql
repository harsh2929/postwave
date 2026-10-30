-- 0151_audit_sinks_nullif_uuid_cast.sql
--
-- Forward-fix: migration 0123 created tenant_visible policies on
-- audit_sinks / audit_merkle_roots / audit_sink_failures that cast
-- current_setting('app.tenant_id', true)::uuid without a NULLIF
-- guard. When the auditsink background worker runs with
-- app.tenant_id unset, the cast fails with
-- SQLSTATE 22P02 "invalid input syntax for type uuid: \"\"".
--
-- This blocks the worker tick every 5 seconds (visible as
-- repeated "load sinks" / "auditsink tick failed" warnings) even
-- though the audit_sinks_worker_* PERMISSIVE policy SHOULD have
-- been sufficient — Postgres still evaluates every PERMISSIVE
-- policy's USING expression for SELECT, so an erroring expression
-- kills the whole row visibility check.
--
-- Fix: rewrite the three policies to NULLIF the empty string
-- before the uuid cast — matches the pattern used by every other
-- table in the codebase.

BEGIN;

DROP POLICY IF EXISTS tenant_visible ON audit_sinks;
CREATE POLICY tenant_visible ON audit_sinks AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON audit_merkle_roots;
CREATE POLICY tenant_visible ON audit_merkle_roots AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON audit_sink_failures;
CREATE POLICY tenant_visible ON audit_sink_failures AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
