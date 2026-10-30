-- 1809_landing_page_versions.sql
-- LAND-039 (acceptance #2): version history + restore for landing pages.
-- Every Update snapshots the PRE-overwrite content into this table (inside the
-- same tx), so an operator can view prior versions and restore one. Mirrors the
-- flows version subsystem. Snapshots the editable content (name/status/slug +
-- blocks/seo/tracking jsonb) plus who/when.

CREATE TABLE IF NOT EXISTS landing_page_versions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    page_id     uuid NOT NULL,
    version_no  integer NOT NULL,
    name        text NOT NULL DEFAULT '',
    status      text NOT NULL DEFAULT 'draft',
    slug        citext,
    blocks      jsonb NOT NULL DEFAULT '[]'::jsonb,
    seo         jsonb NOT NULL DEFAULT '{}'::jsonb,
    tracking    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by  uuid,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, page_id, version_no)
);

CREATE INDEX IF NOT EXISTS landing_page_versions_page_idx
    ON landing_page_versions (tenant_id, page_id, version_no DESC);

ALTER TABLE landing_page_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON landing_page_versions
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON landing_page_versions TO postwave_app;
