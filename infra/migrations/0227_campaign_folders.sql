-- 0227_campaign_folders.sql
--
-- Workstream 2 (campaign-manager polish): organisational folders for
-- campaigns. Mailchimp lets you drop a campaign into a folder; folders
-- are a flat, 1-deep collection per workspace. This migration adds the
-- folder table plus a nullable `folder_id` column on `campaigns` so a
-- campaign can be filed (or sit uncategorised when null).

BEGIN;

CREATE TABLE campaign_folders (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX campaign_folders_tenant_idx
    ON campaign_folders (tenant_id, created_at DESC);

CREATE TRIGGER campaign_folders_set_updated_at
    BEFORE UPDATE ON campaign_folders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_folders TO postwave_app;

ALTER TABLE campaign_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_folders FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON campaign_folders
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON campaign_folders
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Folder pointer on the campaign row. NULL = uncategorised (the
-- default view). ON DELETE SET NULL so deleting a folder doesn't
-- vacuum the campaigns inside it.
ALTER TABLE campaigns
    ADD COLUMN folder_id uuid REFERENCES campaign_folders(id) ON DELETE SET NULL;

CREATE INDEX campaigns_tenant_folder_idx
    ON campaigns (tenant_id, folder_id, updated_at DESC)
    WHERE folder_id IS NOT NULL;

COMMIT;
