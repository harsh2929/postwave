-- 2003_warehouse_concurrency_and_streaming_cursor.sql
--
-- Exact-state warehouse administration and lossless streaming-export cursors.
--
-- Connections and both mapping families were previously last-writer-wins.
-- Positive versions make lifecycle/destructive writes compare-and-swap.  The
-- streaming run cursor fields make a bounded batch explicit: a completed
-- upload may still have more rows in the same cutoff window, while a failed
-- upload never advances the connection cursor.

BEGIN;

ALTER TABLE warehouse_connections
    ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
ALTER TABLE warehouse_connections
    DROP CONSTRAINT IF EXISTS warehouse_connections_version_positive;
ALTER TABLE warehouse_connections
    ADD CONSTRAINT warehouse_connections_version_positive CHECK (version > 0);

ALTER TABLE warehouse_import_mappings
    ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
ALTER TABLE warehouse_import_mappings
    DROP CONSTRAINT IF EXISTS warehouse_import_mappings_version_positive;
ALTER TABLE warehouse_import_mappings
    ADD CONSTRAINT warehouse_import_mappings_version_positive CHECK (version > 0);

ALTER TABLE warehouse_reverse_etl_mappings
    ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
ALTER TABLE warehouse_reverse_etl_mappings
    DROP CONSTRAINT IF EXISTS warehouse_reverse_etl_mappings_version_positive;
ALTER TABLE warehouse_reverse_etl_mappings
    ADD CONSTRAINT warehouse_reverse_etl_mappings_version_positive CHECK (version > 0);

ALTER TABLE streaming_export_runs
    ADD COLUMN IF NOT EXISTS cursor_from bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cursor_to bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS has_more boolean NOT NULL DEFAULT false;

ALTER TABLE streaming_export_runs
    DROP CONSTRAINT IF EXISTS streaming_export_runs_cursor_order;
ALTER TABLE streaming_export_runs
    ADD CONSTRAINT streaming_export_runs_cursor_order
        CHECK (cursor_from >= 0 AND cursor_to >= cursor_from);

CREATE INDEX IF NOT EXISTS streaming_export_runs_cursor_idx
    ON streaming_export_runs (tenant_id, connection_id, cursor_to DESC, created_at DESC);

COMMIT;
