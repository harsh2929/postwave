-- 1549_databricks_warehouse_provider_parity.sql
-- Admit Databricks to the managed warehouse connector control plane.

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
            'databricks',
            'azure_blob',
            'snowflake',
            'postgres',
            'streaming_export'
        ));
END$$;

COMMIT;
