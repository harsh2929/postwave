-- 0280_tag_groups.sql
--
-- Tags refinement 9/12 — tag groups / namespaces (Klaviyo Tag Groups parity).
--
-- Adds:
--   * tag_groups(id, tenant_id, name, color, sort_order, created_at)
--       — bucket tags into 'Campaign Type', 'Funnel Stage', etc.
--   * tags.group_id uuid NULL — FK ON DELETE SET NULL so deleting a
--       group leaves the tags but unbuckets them ("No group").
--
-- RLS uses the canonical NULLIF GUC idiom so an unset tenant_id GUC
-- never crashes.

BEGIN;

CREATE TABLE IF NOT EXISTS tag_groups (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
    color      text,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS tag_groups_tenant_sort_idx
    ON tag_groups (tenant_id, sort_order, name);

GRANT SELECT, INSERT, UPDATE, DELETE ON tag_groups TO postwave_app;

ALTER TABLE tag_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE tag_groups FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tag_groups;
CREATE POLICY tenant_isolation ON tag_groups
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON tag_groups;
CREATE POLICY tenant_visible ON tag_groups
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE tags
    ADD COLUMN IF NOT EXISTS group_id uuid
        REFERENCES tag_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tags_group_idx
    ON tags (tenant_id, group_id)
    WHERE group_id IS NOT NULL;

COMMIT;
