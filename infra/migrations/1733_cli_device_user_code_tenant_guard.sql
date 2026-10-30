-- 1733_cli_device_user_code_tenant_guard.sql
--
-- A short RFC 8628 user code is an approval locator, not stand-alone database
-- authority. Require an authenticated transaction-local tenant alongside that
-- code before a pending CLI device grant is visible. The approval repository
-- already uses db.WithTenant, so this tightens the policy without changing the
-- supported flow.
--
-- rollback-strategy: no-op - removing the tenant guard would broaden pre-auth
-- row visibility to any database transaction that can set only the short code.

BEGIN;

DROP POLICY IF EXISTS cli_device_grant_secret_user_code_or_tenant ON cli_device_grants;
CREATE POLICY cli_device_grant_secret_user_code_or_tenant ON cli_device_grants
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR device_code_hash = NULLIF(current_setting('app.cli_device_grant_hash', true), '')
        OR (
            tenant_id IS NULL
            AND NULLIF(current_setting('app.tenant_id', true), '') IS NOT NULL
            AND user_code = NULLIF(current_setting('app.cli_device_user_code', true), '')
        )
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR device_code_hash = NULLIF(current_setting('app.cli_device_grant_hash', true), '')
    );

COMMIT;
