-- Allow an authenticated agency tenant to read only the tenant rows that are
-- explicitly linked to it. The general tenants policy remains self-only; this
-- narrow permissive policy is required by child listing and ownership checks.
-- Standalone tenants and children of another agency remain invisible.

BEGIN;

DROP POLICY IF EXISTS tenant_agency_children_select ON tenants;
CREATE POLICY tenant_agency_children_select ON tenants
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (
        parent_tenant_id =
            NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

COMMIT;
