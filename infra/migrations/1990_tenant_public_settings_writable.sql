-- 1990_tenant_public_settings_writable.sql
--
-- tenant_public_settings has been unwritable since migration 0152.
--
-- WHAT HAPPENED. 0071 created a RESTRICTIVE `tenant_isolation` policy FOR ALL.
-- Because a RESTRICTIVE policy also constrains SELECT, it blocked the anonymous
-- archive_slug -> tenant_id lookup that the PERMISSIVE public-lookup policy
-- exists to allow. 0152 fixed that by splitting the restrictive policy into
-- three write-only ones (INSERT/UPDATE/DELETE), leaving SELECT to the permissive
-- public-lookup -- which was exactly right for reads.
--
-- It left the table with NO permissive policy covering writes. Postgres requires
-- a row to satisfy at least one PERMISSIVE policy AND every RESTRICTIVE one;
-- restrictive policies can only subtract. With an empty permissive set for
-- INSERT/UPDATE/DELETE, every write is denied no matter how correct the tenant
-- GUC is -- which is why PUT /api/v1/admin/archive/tenant-settings answered 500
-- with "new row violates row-level security policy", with the GUC set to exactly
-- the tenant_id being written.
--
-- Verified rather than reasoned about: with the three restrictive policies in
-- place and app.tenant_id set correctly, a plain INSERT as postwave_app fails;
-- adding one permissive INSERT policy makes the same INSERT succeed.
--
-- THE FIX. Add the missing permissive half. The restrictive policies stay --
-- they are the actual tenant isolation and are now defence in depth rather than
-- the only gate. Every other tenant table in this schema (api_keys, campaigns,
-- subscribers) uses a single PERMISSIVE FOR ALL policy; this one needs the same
-- shape, and its SELECT branch simply ORs with the public archive lookup, which
-- is the design intent 0152 described.

BEGIN;

DROP POLICY IF EXISTS tenant_public_settings_tenant_rw ON tenant_public_settings;

CREATE POLICY tenant_public_settings_tenant_rw ON tenant_public_settings
    AS PERMISSIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
