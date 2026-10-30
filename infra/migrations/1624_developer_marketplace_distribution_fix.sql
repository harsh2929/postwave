-- KLV-13 fix: distribution taxonomy drift.
--
-- developer_marketplace.ValidateApp (developer_marketplace.go:1003) and
-- DistributionCatalog() both advertise + accept five distribution values
-- ('private','marketplace','partner_catalog','native_postwave','catalog_only'),
-- but migration 0210 only ever taught the database three of them. The effect:
--   1. CreateApp with distribution='native_postwave' or 'catalog_only' passed
--      Go validation and then violated the CHECK constraint on INSERT — a
--      hard 500, not a clean 4xx.
--   2. Even had it inserted, the public marketplace index + the two public-read
--      RLS predicates only matched marketplace/partner_catalog, so a
--      catalog_only "listing" (whose entire purpose is to be browsable) would
--      have been invisible.
--
-- Widen all four predicates so the database matches the advertised taxonomy.
-- native_postwave + catalog_only join the public-readable set on the same
-- review gate the existing public types use (status IN ('approved','active')).

ALTER TABLE developer_apps DROP CONSTRAINT IF EXISTS developer_apps_distribution_check;
ALTER TABLE developer_apps ADD CONSTRAINT developer_apps_distribution_check
    CHECK (distribution IN ('private','marketplace','partner_catalog','native_postwave','catalog_only'));

DROP INDEX IF EXISTS developer_apps_public_idx;
CREATE INDEX developer_apps_public_idx
    ON developer_apps (distribution, status, updated_at DESC)
    WHERE distribution IN ('marketplace','partner_catalog','native_postwave','catalog_only')
      AND status IN ('approved','active');

DROP POLICY IF EXISTS tenant_or_public_developer_apps ON developer_apps;
CREATE POLICY tenant_or_public_developer_apps ON developer_apps
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            distribution IN ('marketplace','partner_catalog','native_postwave','catalog_only')
            AND status IN ('approved','active')
        )
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible_developer_apps ON developer_apps;
CREATE POLICY tenant_visible_developer_apps ON developer_apps
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            distribution IN ('marketplace','partner_catalog','native_postwave','catalog_only')
            AND status IN ('approved','active')
        )
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
