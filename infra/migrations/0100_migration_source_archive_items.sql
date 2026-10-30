-- 0100_migration_source_archive_items.sql
--
-- Read-only preservation for source-side objects that are required for
-- migration parity but do not yet have executable Postwave modules.

BEGIN;

CREATE TABLE IF NOT EXISTS migration_source_archive_items (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    migration_job_id    uuid NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
    source_platform     text NOT NULL,
    resource_type       text NOT NULL,
    source_id           text NOT NULL,
    name                text NOT NULL DEFAULT '',
    status              text NOT NULL DEFAULT '',
    linked_contact_id   text NOT NULL DEFAULT '',
    occurred_at         timestamptz,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, migration_job_id, resource_type, source_id)
);

CREATE INDEX IF NOT EXISTS migration_source_archive_items_job_idx
    ON migration_source_archive_items (tenant_id, migration_job_id, resource_type, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON migration_source_archive_items TO postwave_app;

ALTER TABLE migration_source_archive_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_source_archive_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration_source_archive_items;
CREATE POLICY tenant_isolation ON migration_source_archive_items
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
