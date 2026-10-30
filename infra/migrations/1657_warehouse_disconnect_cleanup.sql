-- Preserve warehouse connection disconnect evidence instead of hard-deleting
-- rows and detaching warehouse sync-run history.

BEGIN;

ALTER TABLE warehouse_connections
    DROP CONSTRAINT IF EXISTS warehouse_connections_status_check;

ALTER TABLE warehouse_connections
    ADD CONSTRAINT warehouse_connections_status_check
    CHECK (status IN (
        'draft',
        'active',
        'paused',
        'error',
        'disconnected'
    ));

COMMIT;
