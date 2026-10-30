-- 1101_warehouse_reverse_etl_mappings.sql
--
-- SUB-112 — Reverse ETL: warehouse-managed traits → subscriber custom fields.
--
-- Capability: columns from a remote warehouse (Snowflake/BigQuery/Redshift)
-- sync BACK onto subscribers as queryable custom fields. This is the import
-- direction's "profile traits" variant: instead of turning warehouse rows
-- into events (warehouse_import_mappings, migration 0207), each mapping links
-- one warehouse column path to one subscriber custom-field key, with an
-- optional type cast.
--
-- Reuses the existing warehouse_connections + credential machinery
-- (credentials_ref). A mapping belongs to a connection; an execution
-- ("sync traits now") matches incoming rows to subscribers by a profile key
-- column (default email) and writes the mapped values into
-- subscribers.custom_fields jsonb via a bulk UPDATE.
--
-- Tenant scoping + RLS shape copied from 0207 / 0303: every policy reads the
-- tenant via NULLIF(current_setting('app.tenant_id', true), '')::uuid so an
-- unset GUC does not crash the cast.

BEGIN;

CREATE TABLE IF NOT EXISTS warehouse_reverse_etl_mappings (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    connection_id      uuid NOT NULL REFERENCES warehouse_connections(id) ON DELETE CASCADE,
    -- source warehouse table the columns are read from.
    source_table       text NOT NULL,
    -- column in the source rows that identifies the subscriber (matched
    -- against subscribers.email by default).
    profile_key_column text NOT NULL DEFAULT 'email',
    -- which subscriber column the profile_key_column matches against;
    -- 'email' today (the indexed identity column). Reserved for future
    -- external_id / phone matching.
    profile_key_target text NOT NULL DEFAULT 'email'
                       CHECK (profile_key_target IN ('email')),
    -- warehouse column path → subscriber custom-field key.
    source_column      text NOT NULL,
    target_field_key   text NOT NULL,
    -- optional cast applied to the incoming value before it lands in
    -- custom_fields. 'string' is the safe default (everything coerces).
    cast_type          text NOT NULL DEFAULT 'string'
                       CHECK (cast_type IN ('string','number','boolean','date','datetime','json')),
    status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('draft','active','paused')),
    last_synced_at     timestamptz,
    last_row_count     bigint NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    -- one mapping per (connection, source_table, source_column) — a single
    -- warehouse column flows to exactly one custom field.
    UNIQUE (tenant_id, connection_id, source_table, source_column)
);

CREATE INDEX IF NOT EXISTS warehouse_reverse_etl_mappings_conn_idx
    ON warehouse_reverse_etl_mappings (tenant_id, connection_id, status);

CREATE TRIGGER warehouse_reverse_etl_mappings_set_updated_at
    BEFORE UPDATE ON warehouse_reverse_etl_mappings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON warehouse_reverse_etl_mappings TO postwave_app;

ALTER TABLE warehouse_reverse_etl_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_reverse_etl_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warehouse_reverse_etl_mappings
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON warehouse_reverse_etl_mappings
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
