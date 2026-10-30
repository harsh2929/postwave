-- 1572_developer_marketplace_review_queue_rls.sql
--
-- Read-only cross-tenant RLS scope for the developer marketplace review queue.
-- Review decisions still execute through tenant-scoped writes; this scope only
-- lets reviewer tooling enumerate submitted app/listing candidates.

BEGIN;

DROP POLICY IF EXISTS tenant_or_public_developer_apps ON developer_apps;
DROP POLICY IF EXISTS tenant_visible_developer_apps ON developer_apps;

CREATE POLICY tenant_or_public_developer_apps ON developer_apps
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR NULLIF(current_setting('app.developer_marketplace_reviewer', true), '') = 'true'
        OR (
            distribution IN ('marketplace','partner_catalog')
            AND status IN ('approved','active')
        )
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible_developer_apps ON developer_apps
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR NULLIF(current_setting('app.developer_marketplace_reviewer', true), '') = 'true'
        OR (
            distribution IN ('marketplace','partner_catalog')
            AND status IN ('approved','active')
        )
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_or_public_app_listings ON app_listings;
DROP POLICY IF EXISTS tenant_visible_app_listings ON app_listings;

CREATE POLICY tenant_or_public_app_listings ON app_listings
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR NULLIF(current_setting('app.developer_marketplace_reviewer', true), '') = 'true'
        OR (status = 'published' AND review_state = 'approved')
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible_app_listings ON app_listings
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR NULLIF(current_setting('app.developer_marketplace_reviewer', true), '') = 'true'
        OR (status = 'published' AND review_state = 'approved')
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_or_certified_partner_profiles ON partner_program_profiles;
DROP POLICY IF EXISTS tenant_visible_partner_profiles ON partner_program_profiles;

CREATE POLICY tenant_or_certified_partner_profiles ON partner_program_profiles
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR NULLIF(current_setting('app.developer_marketplace_reviewer', true), '') = 'true'
        OR status = 'certified'
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible_partner_profiles ON partner_program_profiles
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR NULLIF(current_setting('app.developer_marketplace_reviewer', true), '') = 'true'
        OR status = 'certified'
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
