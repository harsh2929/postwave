-- 0038_archive.sql
--
-- Public campaign archive + per-tenant archive slug. Domain B owns the
-- campaigns table; this migration only adds opt-in archive columns and a
-- tiny tenant_public_settings row. The archive read package never mutates
-- campaigns, only SELECTs it directly.

BEGIN;

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS archive_public  boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS archive_slug    text,
    ADD COLUMN IF NOT EXISTS archive_excerpt text,
    -- body is the rendered HTML mirrored from Listmonk so the public archive
    -- and pre-send link checker can read it without a Listmonk round-trip.
    -- Nullable: campaigns that haven't rendered yet keep NULL.
    ADD COLUMN IF NOT EXISTS body            text;

CREATE UNIQUE INDEX IF NOT EXISTS campaigns_tenant_archive_slug_uniq
    ON campaigns (tenant_id, archive_slug)
    WHERE archive_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS campaigns_archive_public_idx
    ON campaigns (tenant_id, archive_public)
    WHERE archive_public = true;

CREATE TABLE IF NOT EXISTS tenant_public_settings (
    tenant_id            uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    tenant_archive_slug  citext UNIQUE,
    archive_domain       citext,
    updated_at           timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_public_settings TO postwave_app;

ALTER TABLE tenant_public_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_public_settings FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_public_settings
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_public_settings_public_lookup ON tenant_public_settings
    AS PERMISSIVE FOR SELECT
    USING (tenant_archive_slug IS NOT NULL);

COMMIT;
