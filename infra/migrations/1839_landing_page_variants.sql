-- 1839_landing_page_variants.sql
--
-- LAND-037 — A/B testing for landing pages. A page can define 2+ variants, each
-- with its own content (blocks) and a traffic weight; the public serve path
-- picks one weighted, returns it, and attributes the view (and any conversion)
-- to that variant, so per-variant conversion metrics are data-backed. With no
-- variants defined, serving and tracking behave exactly as before (the page IS
-- the control).
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Additive table + a nullable growth_surface_events.variant_id
-- column. Older code never selects the variant; NULL variant_id = the control.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS landing_page_variants (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    page_id     uuid NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
    name        text NOT NULL DEFAULT '',
    -- Relative traffic weight; a variant with weight 0 is paused (never served).
    weight      integer NOT NULL DEFAULT 1 CHECK (weight >= 0),
    -- Variant content, same shape as landing_pages.blocks.
    blocks      jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Exactly one variant per page should be the control (the baseline).
    is_control  boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS landing_page_variants_page_idx
    ON landing_page_variants (tenant_id, page_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON landing_page_variants TO postwave_app;

ALTER TABLE landing_page_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE landing_page_variants FORCE ROW LEVEL SECURITY;

-- Admin: standard tenant isolation.
DROP POLICY IF EXISTS tenant_isolation ON landing_page_variants;
CREATE POLICY tenant_isolation ON landing_page_variants
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Public serve: the anonymous serve path sets app.public_landing_slug (no
-- tenant GUC), so a permissive SELECT policy lets it read the variants of the
-- PUBLISHED page for that slug — mirroring landing_pages' own public policy.
DROP POLICY IF EXISTS public_landing_variant_read ON landing_page_variants;
CREATE POLICY public_landing_variant_read ON landing_page_variants
    FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM landing_pages p
        WHERE p.id = landing_page_variants.page_id
          AND p.status = 'published'
          AND p.slug = NULLIF(current_setting('app.public_landing_slug', true), '')::citext
    ));

-- Per-variant event attribution. NULL = the control / a page with no variants,
-- so existing aggregations that ignore the column keep working unchanged.
ALTER TABLE growth_surface_events
    ADD COLUMN IF NOT EXISTS variant_id uuid;

-- growth_surface_events is column-granted, so the new column needs explicit
-- INSERT + SELECT for the non-owner runtime role (RLS/policy alone is not a
-- privilege).
GRANT INSERT (variant_id), SELECT (variant_id) ON growth_surface_events TO postwave_app;

COMMIT;
