-- 0030_assets.sql
--
-- Image library for the Postwave dashboard. Tenant-scoped. Storage backend
-- is either Cloudflare R2 (preferred) or local filesystem fallback under
-- ${POSTWAVE_DATA_DIR}/assets/. The storage_key is the bucket key (R2) or
-- relative path (filesystem); url is the canonical browser-resolvable URL.

BEGIN;

CREATE TABLE assets (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    filename     text NOT NULL,
    mime         text NOT NULL,
    bytes        bigint NOT NULL,
    width        int NOT NULL DEFAULT 0,
    height       int NOT NULL DEFAULT 0,
    storage_key  text NOT NULL,
    url          text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz
);

CREATE INDEX assets_tenant_created_idx ON assets (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON assets TO postwave_app;

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON assets
    AS RESTRICTIVE
    FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
