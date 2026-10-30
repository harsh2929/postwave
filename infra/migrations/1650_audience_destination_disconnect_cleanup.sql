-- Preserve native audience destination disconnect evidence instead of
-- hard-deleting the row and cascading sync history.

BEGIN;

ALTER TABLE audience_destinations
    DROP CONSTRAINT IF EXISTS audience_destinations_status_check;

ALTER TABLE audience_destinations
    ADD CONSTRAINT audience_destinations_status_check
    CHECK (status IN (
        'draft',
        'active',
        'paused',
        'syncing',
        'error',
        'disconnected'
    ));

COMMIT;
