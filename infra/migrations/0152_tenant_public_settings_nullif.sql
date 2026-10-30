-- 0152_tenant_public_settings_nullif.sql
--
-- Forward-fix: migration 0071 created tenant_public_settings with a
-- RESTRICTIVE tenant_isolation policy that applies to FOR ALL (incl
-- SELECT) AND casts current_setting('app.tenant_id', true)::uuid
-- without NULLIF.
--
-- The table ALSO has a PERMISSIVE public-lookup policy whose purpose
-- is exactly to allow anonymous archive_slug → tenant_id resolution
-- without a tenant context. But because the RESTRICTIVE policy
-- applies to SELECT too, the public lookup is blocked: an empty
-- `app.tenant_id` GUC means `current_setting(...)` is NULL,
-- `NULL::uuid` either errors or matches nothing, so no row visible.
--
-- Fix: scope the tenant_isolation policy to write operations only
-- (INSERT/UPDATE/DELETE). SELECT is governed by the PERMISSIVE
-- public-lookup, which is the design intent.

BEGIN;

DROP POLICY IF EXISTS tenant_isolation ON tenant_public_settings;

CREATE POLICY tenant_isolation_write ON tenant_public_settings
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_update ON tenant_public_settings
    AS RESTRICTIVE FOR UPDATE
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_delete ON tenant_public_settings
    AS RESTRICTIVE FOR DELETE
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
