-- Preserve commerce disconnect cleanup evidence instead of hard-deleting the
-- integration row from the normal API disconnect path.

BEGIN;

ALTER TABLE commerce_integrations
    DROP CONSTRAINT IF EXISTS commerce_integrations_status_check;

ALTER TABLE commerce_integrations
    ADD CONSTRAINT commerce_integrations_status_check
    CHECK (status IN (
        'connected',
        'needs_auth',
        'syncing',
        'paused',
        'error',
        'disconnected'
    ));

COMMIT;
