-- 1732_cli_device_and_region_history_rls.sql
--
-- Close the final two tenant-table RLS gaps reported by the effective-schema
-- verifier. CLI device grants have a pre-auth phase, so their policy accepts
-- only a transaction-local device-code hash or approving user code until the
-- row becomes tenant-bound. Region-history access is always tenant scoped.
--
-- rollback-strategy: no-op - removing these policies would reintroduce
-- cross-tenant visibility and session-pool scope risks.

BEGIN;

ALTER TABLE cli_device_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE cli_device_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cli_device_grant_secret_user_code_or_tenant ON cli_device_grants;
CREATE POLICY cli_device_grant_secret_user_code_or_tenant ON cli_device_grants
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR device_code_hash = NULLIF(current_setting('app.cli_device_grant_hash', true), '')
        OR (
            tenant_id IS NULL
            AND user_code = NULLIF(current_setting('app.cli_device_user_code', true), '')
        )
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR device_code_hash = NULLIF(current_setting('app.cli_device_grant_hash', true), '')
    );

ALTER TABLE tenant_region_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_region_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_region_history_tenant_isolation ON tenant_region_history;
CREATE POLICY tenant_region_history_tenant_isolation ON tenant_region_history
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
