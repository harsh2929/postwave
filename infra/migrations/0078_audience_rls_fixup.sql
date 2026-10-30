-- 0078_audience_rls_fixup.sql
--
-- Continuation of 0077: same RESTRICTIVE-only RLS bug pattern on four
-- audience/monetization tables. The agent doing the X1+X2+X3 backend
-- ?query= work surfaced these by trying to seed test data and getting
-- 42501 row-violates-policy errors despite app.tenant_id being set
-- correctly.
--
-- Tables: tags, suppressions, discounts, inbound_webhook_endpoints.
--
-- Postgres PERMISSIVE/RESTRICTIVE semantics:
--   - PERMISSIVE policies are ORed; if NONE are defined for a role,
--     access is denied by default under FORCE ROW LEVEL SECURITY.
--   - RESTRICTIVE policies are ANDed on top of the OR; they're a
--     defence-in-depth filter, NOT a permit.
--
-- The fix mirrors 0077: add a permissive companion policy. The
-- existing restrictive policies are kept as the cross-tenant guard.

BEGIN;

CREATE POLICY tenant_visible ON tags
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_visible ON suppressions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_visible ON discounts
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_visible ON inbound_webhook_endpoints
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
