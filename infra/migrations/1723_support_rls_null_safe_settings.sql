-- 1723_support_rls_null_safe_settings.sql
--
-- Preserve the null-safe support policy repair as a forward migration. This
-- lets checksum-tracked migration 1543 remain byte-for-byte immutable on every
-- database that has already applied it.
--
-- rollback-strategy: no-op - the predicates are equivalent for a valid tenant
-- setting and safely deny access when the setting is absent or empty.

BEGIN;

DROP POLICY IF EXISTS tenant_isolation ON support_integrations;
CREATE POLICY tenant_isolation ON support_integrations
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON support_sync_runs;
CREATE POLICY tenant_isolation ON support_sync_runs
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
