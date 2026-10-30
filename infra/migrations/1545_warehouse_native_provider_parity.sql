-- 1545_warehouse_native_provider_parity.sql
--
-- Promote the warehouse control plane from S3/R2 plus roadmap placeholders to
-- the native-managed connector set used by the Integrations hub. Driver
-- workers still attach behind warehouse_connections; this migration only
-- admits the managed provider keys in the existing RLS-protected table.

BEGIN;

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
            's3',
            'r2',
            'redshift',
            'bigquery',
            'azure_blob',
            'snowflake',
            'postgres',
            'streaming_export'
        ));
END$$;

CREATE INDEX IF NOT EXISTS warehouse_connections_tenant_provider_status_idx
    ON warehouse_connections (tenant_id, provider, status);

COMMIT;
