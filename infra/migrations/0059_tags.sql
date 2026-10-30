-- 0026_tags.sql
--
-- Tenant-scoped tag catalog. Subscriber-tag application stays where it is
-- (subscribers.tags text[] from 0003_subscribers.sql); this table is the
-- canonical list of known tags so the UI can present a picker and the API
-- can surface usage stats / rename / delete.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE tags (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        citext NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX tags_tenant_idx ON tags (tenant_id, name);

GRANT SELECT, INSERT, UPDATE, DELETE ON tags TO postwave_app;

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tags
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
