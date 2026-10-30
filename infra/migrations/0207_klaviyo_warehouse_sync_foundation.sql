-- 0207_klaviyo_warehouse_sync_foundation.sql
--
-- Klaviyo parity slice KLV-08: managed warehouse export/import control plane.
-- S3 JSONL bundles are executable first; warehouse-specific loaders/pollers can
-- attach to the same connection, run, mapping, and row-error ledger.

BEGIN;

CREATE TABLE warehouse_connections (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name              text NOT NULL,
    provider          text NOT NULL
                      CHECK (provider IN ('s3','redshift','bigquery','azure_blob','snowflake')),
    direction         text NOT NULL DEFAULT 'export'
                      CHECK (direction IN ('export','import','bidirectional')),
    status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('draft','active','paused','error')),
    credentials_ref   text NOT NULL DEFAULT '',
    config            jsonb NOT NULL DEFAULT '{}',
    object_selection  text[] NOT NULL DEFAULT '{}'::text[],
    cadence           text NOT NULL DEFAULT 'manual'
                      CHECK (cadence IN ('manual','hourly','daily','weekly')),
    backfill_days     integer NOT NULL DEFAULT 90 CHECK (backfill_days BETWEEN 1 AND 3650),
    last_cursor       text NOT NULL DEFAULT '',
    error             text NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX warehouse_connections_tenant_provider_idx
    ON warehouse_connections (tenant_id, provider, status);

CREATE TRIGGER warehouse_connections_set_updated_at
    BEFORE UPDATE ON warehouse_connections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON warehouse_connections TO postwave_app;

ALTER TABLE warehouse_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warehouse_connections
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON warehouse_connections
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE warehouse_sync_runs (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    connection_id     uuid REFERENCES warehouse_connections(id) ON DELETE SET NULL,
    direction         text NOT NULL CHECK (direction IN ('export','import')),
    run_mode          text NOT NULL DEFAULT 'manual'
                      CHECK (run_mode IN ('manual','scheduled','backfill','retry','dry_run')),
    status            text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','completed','failed','cancelled')),
    object_selection  text[] NOT NULL DEFAULT '{}'::text[],
    input_uri         text NOT NULL DEFAULT '',
    output_uri        text NOT NULL DEFAULT '',
    cursor_from       text NOT NULL DEFAULT '',
    cursor_to         text NOT NULL DEFAULT '',
    rows_scanned      bigint NOT NULL DEFAULT 0,
    rows_exported     bigint NOT NULL DEFAULT 0,
    rows_imported     bigint NOT NULL DEFAULT 0,
    rows_failed       bigint NOT NULL DEFAULT 0,
    schema_errors     bigint NOT NULL DEFAULT 0,
    retry_count       integer NOT NULL DEFAULT 0,
    metrics           jsonb NOT NULL DEFAULT '{}',
    error             text NOT NULL DEFAULT '',
    started_at        timestamptz,
    completed_at      timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX warehouse_sync_runs_tenant_recent_idx
    ON warehouse_sync_runs (tenant_id, created_at DESC);
CREATE INDEX warehouse_sync_runs_connection_status_idx
    ON warehouse_sync_runs (tenant_id, connection_id, status, created_at DESC);

CREATE TRIGGER warehouse_sync_runs_set_updated_at
    BEFORE UPDATE ON warehouse_sync_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON warehouse_sync_runs TO postwave_app;

ALTER TABLE warehouse_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warehouse_sync_runs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON warehouse_sync_runs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE warehouse_import_mappings (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    connection_id       uuid NOT NULL REFERENCES warehouse_connections(id) ON DELETE CASCADE,
    source_object       text NOT NULL,
    target_event_name   text NOT NULL DEFAULT '',
    profile_key_column  text NOT NULL DEFAULT 'email',
    occurred_at_column  text NOT NULL DEFAULT 'occurred_at',
    property_map        jsonb NOT NULL DEFAULT '{}',
    validation_rules    jsonb NOT NULL DEFAULT '{}',
    status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('draft','active','paused')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, connection_id, source_object)
);

CREATE INDEX warehouse_import_mappings_connection_idx
    ON warehouse_import_mappings (tenant_id, connection_id, status);

CREATE TRIGGER warehouse_import_mappings_set_updated_at
    BEFORE UPDATE ON warehouse_import_mappings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON warehouse_import_mappings TO postwave_app;

ALTER TABLE warehouse_import_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_import_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warehouse_import_mappings
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON warehouse_import_mappings
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE warehouse_row_errors (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    run_id          uuid NOT NULL REFERENCES warehouse_sync_runs(id) ON DELETE CASCADE,
    source_object   text NOT NULL DEFAULT '',
    row_number      bigint NOT NULL DEFAULT 0,
    error_code      text NOT NULL,
    error_message   text NOT NULL,
    raw_row         jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX warehouse_row_errors_run_idx
    ON warehouse_row_errors (tenant_id, run_id, row_number);

GRANT SELECT, INSERT, DELETE ON warehouse_row_errors TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE warehouse_row_errors_id_seq TO postwave_app;

ALTER TABLE warehouse_row_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_row_errors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warehouse_row_errors
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON warehouse_row_errors
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
