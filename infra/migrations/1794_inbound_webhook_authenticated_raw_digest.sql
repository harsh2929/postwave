-- 1794_inbound_webhook_authenticated_raw_digest.sql
-- rollback-strategy: expand-contract
-- rollback-details: leave the nullable digest column and constraint in place
-- on rollback. Older binaries ignore it; forward binaries continue using it
-- to distinguish sender replays from transformed-payload collisions.
--
-- Replay identity is authenticated against the sender's exact raw bytes.
-- Comparing only the retained transformed body made exact retries conflict
-- after a transform edit and allowed distinct raw bodies that collapse to one
-- transformed value to alias. Persist a one-way digest of the authenticated
-- raw bytes; raw request content is not duplicated.

ALTER TABLE inbound_events
    ADD COLUMN IF NOT EXISTS authenticated_raw_body_sha256 bytea;

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'inbound_events'::regclass
           AND conname = 'inbound_events_authenticated_raw_digest_length_check'
    ) THEN
        ALTER TABLE inbound_events
            ADD CONSTRAINT inbound_events_authenticated_raw_digest_length_check
            CHECK (
                authenticated_raw_body_sha256 IS NULL
                OR octet_length(authenticated_raw_body_sha256) = 32
            )
            NOT VALID;
    END IF;
END
$migration$;

ALTER TABLE inbound_events
    VALIDATE CONSTRAINT inbound_events_authenticated_raw_digest_length_check;

COMMENT ON COLUMN inbound_events.authenticated_raw_body_sha256 IS
    'SHA-256 of the exact authenticated request bytes; replay collision identity only, never transformed content.';
