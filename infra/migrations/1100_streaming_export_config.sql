-- 1100_streaming_export_config.sql
--
-- SUB-111 — Currents-style real-time event streaming export.
--
-- Capability: ship subscriber.* events + activity stream to
-- S3/Snowflake/BigQuery in Parquet/Avro, hourly-batched.
--
-- Design: reuse the existing warehouse_connections control plane
-- (migration 0207) rather than inventing a parallel destination model.
-- Two changes are needed:
--
--   (A) extend warehouse_connections.provider CHECK to admit a new
--       'streaming_export' provider type. A streaming-export connection
--       carries its format/compression/batch_size in the existing
--       config jsonb column (parsed by streaming_export/encoder_*.go);
--       no new columns are required on warehouse_connections itself.
--
--   (B) a dedicated streaming_export_runs ledger so the hourly batch
--       worker can record each shipment (window, format, rows, bytes,
--       object_uri, last-shipped-at) independently of the generic
--       warehouse_sync_runs ledger — streaming runs are high-frequency
--       and have a distinct shape (a time window + an object_uri per
--       shipment) that we do not want to overload onto warehouse_sync_runs.
--
-- Tenant scoping + RLS shape copied from 0207_klaviyo_warehouse_sync_foundation.sql
-- and 0303_subscriber_signup_source.sql: every policy reads the tenant via
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid so an unset GUC
-- does not crash the cast.

BEGIN;

-- (A) Admit 'streaming_export' as a provider on warehouse_connections.
-- The constraint is recreated (drop + add) so the new value lands without
-- touching existing rows. Guarded so a re-run in a test fixture is a no-op.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'warehouse_connections_provider_check'
    ) THEN
        ALTER TABLE warehouse_connections
            DROP CONSTRAINT warehouse_connections_provider_check;
    END IF;
    ALTER TABLE warehouse_connections
        ADD CONSTRAINT warehouse_connections_provider_check
        CHECK (provider IN (
            's3','redshift','bigquery','azure_blob','snowflake','streaming_export'
        ));
END$$;

-- (B) streaming_export_runs — one row per hourly batch shipment.
CREATE TABLE IF NOT EXISTS streaming_export_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    connection_id   uuid NOT NULL REFERENCES warehouse_connections(id) ON DELETE CASCADE,
    status          text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','completed','failed','empty')),
    format          text NOT NULL DEFAULT 'parquet'
                    CHECK (format IN ('parquet','avro')),
    compression     text NOT NULL DEFAULT 'snappy'
                    CHECK (compression IN ('none','snappy','gzip','zstd')),
    window_start    timestamptz NOT NULL,
    window_end      timestamptz NOT NULL,
    rows_shipped    bigint NOT NULL DEFAULT 0,
    bytes_shipped   bigint NOT NULL DEFAULT 0,
    object_uri      text NOT NULL DEFAULT '',
    error           text NOT NULL DEFAULT '',
    started_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- runs history + last-shipped lookup are both newest-first per connection.
CREATE INDEX IF NOT EXISTS streaming_export_runs_conn_recent_idx
    ON streaming_export_runs (tenant_id, connection_id, created_at DESC);
-- worker claim path filters on status + window to find connections whose
-- next hourly window is due.
CREATE INDEX IF NOT EXISTS streaming_export_runs_status_idx
    ON streaming_export_runs (tenant_id, status, window_end DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON streaming_export_runs TO postwave_app;

ALTER TABLE streaming_export_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE streaming_export_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON streaming_export_runs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON streaming_export_runs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
