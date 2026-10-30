-- 1237_segment_folders.sql
--
-- SUB-040 — segment folders. A flat (single-level) folder table so the
-- 2026 segment-organizer UI can group saved-segment bookmarks under a
-- named folder ("Lifecycle", "Win-back", ...). Distinct from pinning,
-- which is an ad-hoc top-of-list affordance.
--
-- 2026 SOTA references:
--   * Klaviyo — segments + lists live in nestable folders; this is the
--     flat first step (one level), which the orchestration plan calls
--     out as sufficient for parity.
--   * HubSpot — "Folders" group active/static lists.
--
-- saved_segments gains a nullable folder_id with ON DELETE SET NULL so
-- deleting a folder un-files its segments rather than cascading them
-- into oblivion. The (tenant_id, name) unique constraint keeps folder
-- names unambiguous per workspace.

BEGIN;

CREATE TABLE IF NOT EXISTS segment_folders (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS segment_folders_tenant_idx
    ON segment_folders (tenant_id, name);

CREATE TRIGGER segment_folders_set_updated_at
    BEFORE UPDATE ON segment_folders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON segment_folders TO postwave_app;

ALTER TABLE segment_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE segment_folders FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON segment_folders
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON segment_folders
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Link saved segments to a folder. ON DELETE SET NULL so deleting a
-- folder un-files (rather than deletes) its segments.
ALTER TABLE saved_segments
    ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES segment_folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS saved_segments_tenant_folder_idx
    ON saved_segments (tenant_id, folder_id);

COMMIT;
