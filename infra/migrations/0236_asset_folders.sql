-- 0236_asset_folders.sql
--
-- Mailchimp-parity follow-up to Workstream 4 (asset tagging): asset
-- folders. Operators want to file uploads into folders the same way they
-- file campaigns. Folders are a flat, 1-deep, per-tenant collection (no
-- nesting); each asset belongs to at most one folder. NULL `folder_id`
-- means "Uncategorised" (the default landing state for new uploads).
--
-- Mirrors the `campaign_folders` shape introduced in 0227 so the RLS +
-- ON DELETE SET NULL semantics stay consistent across the platform:
-- deleting a folder leaves its assets in place (just unfiled) rather
-- than vacuuming them.

BEGIN;

CREATE TABLE asset_folders (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name),
    CHECK (length(name) BETWEEN 1 AND 128)
);

-- The folder chip-row in the library reads "all folders for this
-- tenant, newest first". This composite index keeps that scan cheap
-- even for tenants with hundreds of folders.
CREATE INDEX asset_folders_tenant_idx
    ON asset_folders (tenant_id, created_at DESC);

CREATE TRIGGER asset_folders_set_updated_at
    BEFORE UPDATE ON asset_folders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON asset_folders TO postwave_app;

ALTER TABLE asset_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_folders FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON asset_folders
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON asset_folders
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Folder pointer on the asset row. NULL = uncategorised (the default
-- view). ON DELETE SET NULL so deleting a folder doesn't vacuum the
-- assets inside it — operators expect "delete folder" to mean "remove
-- the folder bucket, leave the photos".
ALTER TABLE assets
    ADD COLUMN folder_id uuid REFERENCES asset_folders(id) ON DELETE SET NULL;

-- Partial index on (tenant, folder) for the folder-scoped list query.
-- Untagged-folder lookups (`WHERE folder_id IS NULL`) use the existing
-- tenant_id index; no separate "NULL" index needed.
CREATE INDEX assets_tenant_folder_idx
    ON assets (tenant_id, folder_id, created_at DESC)
    WHERE folder_id IS NOT NULL;

COMMIT;
