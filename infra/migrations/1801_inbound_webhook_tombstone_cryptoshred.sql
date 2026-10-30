-- 1801_inbound_webhook_tombstone_cryptoshred.sql
-- rollback-strategy: expand-contract
-- rollback-details: retain destroyed capability material, the expanded storage
-- state, and the enforcement trigger/constraint. Reintroducing signing secrets
-- for deleted endpoints would violate operator deletion intent.
--
-- Tombstoning revokes routing immediately, but historical application builds
-- retained primary signing material in the live row. Destroy all active-row
-- plaintext/envelopes, teach the storage classifier about the terminal state,
-- and enforce the contract for direct SQL and rolling old replicas.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE inbound_webhook_endpoints
    DROP CONSTRAINT IF EXISTS inbound_webhook_endpoints_secret_storage_state_check,
    ADD CONSTRAINT inbound_webhook_endpoints_secret_storage_state_check
    CHECK (
        secret_storage_state IS NULL
        OR secret_storage_state IN (
            'ready', 'legacy_pending', 'invalid', 'destroyed'
        )
    )
    NOT VALID;

CREATE OR REPLACE FUNCTION classify_inbound_webhook_secret_storage()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.secret_storage_state IN ('invalid', 'destroyed') THEN
        RETURN NEW;
    END IF;
    IF NEW.secret = 'envelope:do-not-use'
       AND NEW.secret_envelope IS NOT NULL
       AND octet_length(NEW.secret_envelope) > 0
    THEN
        NEW.secret_storage_state := 'ready';
    ELSE
        NEW.secret_storage_state := 'legacy_pending';
    END IF;
    RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION cryptoshred_inbound_webhook_tombstone()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.deleted_at IS NOT NULL THEN
        NEW.enabled := false;
        NEW.secret := 'tombstone:destroyed';
        NEW.secret_envelope := NULL;
        NEW.secondary_secret := NULL;
        NEW.secondary_secret_envelope := NULL;
        NEW.secondary_expires_at := NULL;
        NEW.secret_storage_state := 'destroyed';
    END IF;
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS inbound_webhook_endpoint_cryptoshred
    ON inbound_webhook_endpoints;
CREATE TRIGGER inbound_webhook_endpoint_cryptoshred
BEFORE INSERT OR UPDATE OF deleted_at
ON inbound_webhook_endpoints
FOR EACH ROW
EXECUTE FUNCTION cryptoshred_inbound_webhook_tombstone();

-- One-time convergence of tombstones created by builds before this migration.
-- This is capability destruction, not customer-evidence deletion: endpoint,
-- event, action-intent, and tombstone metadata remain intact.
UPDATE inbound_webhook_endpoints
   SET enabled = false,
       secret = 'tombstone:destroyed',
       secret_envelope = NULL,
       secondary_secret = NULL,
       secondary_secret_envelope = NULL,
       secondary_expires_at = NULL,
       secret_storage_state = 'destroyed',
       updated_at = now()
 WHERE deleted_at IS NOT NULL
   AND (
       enabled
       OR secret IS DISTINCT FROM 'tombstone:destroyed'
       OR secret_envelope IS NOT NULL
       OR secondary_secret IS NOT NULL
       OR secondary_secret_envelope IS NOT NULL
       OR secondary_expires_at IS NOT NULL
       OR secret_storage_state IS DISTINCT FROM 'destroyed'
   );

ALTER TABLE inbound_webhook_endpoints
    VALIDATE CONSTRAINT inbound_webhook_endpoints_secret_storage_state_check;

ALTER TABLE inbound_webhook_endpoints
    DROP CONSTRAINT IF EXISTS inbound_webhook_endpoints_tombstone_cryptoshred_check,
    ADD CONSTRAINT inbound_webhook_endpoints_tombstone_cryptoshred_check
    CHECK (
        deleted_at IS NULL
        OR (
            enabled = false
            AND secret = 'tombstone:destroyed'
            AND secret_envelope IS NULL
            AND secondary_secret IS NULL
            AND secondary_secret_envelope IS NULL
            AND secondary_expires_at IS NULL
            AND secret_storage_state = 'destroyed'
        )
    )
    NOT VALID;

ALTER TABLE inbound_webhook_endpoints
    VALIDATE CONSTRAINT inbound_webhook_endpoints_tombstone_cryptoshred_check;

COMMENT ON CONSTRAINT inbound_webhook_endpoints_tombstone_cryptoshred_check
    ON inbound_webhook_endpoints IS
    'Deleted endpoints retain evidence but no active-row signing capability material.';

COMMIT;
