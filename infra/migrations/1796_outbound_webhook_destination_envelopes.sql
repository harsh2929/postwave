-- 1796_outbound_webhook_destination_envelopes.sql
-- rollback-strategy: expand-contract
-- rollback-details: retain additive envelope/state/pause columns and triggers.
-- Rewrapped destinations intentionally fail closed on a legacy binary because
-- the url column contains only a redacted display projection. Restore the
-- forward release; never copy ciphertext back into plaintext.
--
-- Receiver URLs frequently contain capability tokens in path or query
-- components. Move the full destination into the platform envelope cipher and
-- keep only a value-free display projection in url. Existing rows are
-- classified lazily: NULL state is legacy_pending and the bounded application
-- worker encrypts/redacts them. Delivery and fanout stay paused until ready.

ALTER TABLE outbound_webhooks
    ADD COLUMN IF NOT EXISTS url_envelope bytea,
    ADD COLUMN IF NOT EXISTS url_state text,
    ADD COLUMN IF NOT EXISTS url_restore_active boolean;

ALTER TABLE outbound_webhook_deliveries
    ADD COLUMN IF NOT EXISTS url_paused_at timestamptz;

ALTER TABLE outbound_webhooks
    ALTER COLUMN url_state SET DEFAULT 'legacy_pending';

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'outbound_webhooks'::regclass
           AND conname = 'outbound_webhooks_url_state_check'
    ) THEN
        ALTER TABLE outbound_webhooks
            ADD CONSTRAINT outbound_webhooks_url_state_check
            CHECK (
                url_state IS NULL
                OR url_state IN ('ready', 'legacy_pending', 'invalid')
            )
            NOT VALID;
    END IF;
END
$migration$;

ALTER TABLE outbound_webhooks
    VALIDATE CONSTRAINT outbound_webhooks_url_state_check;

CREATE INDEX CONCURRENTLY IF NOT EXISTS outbound_webhooks_url_rewrap_pending_idx
    ON outbound_webhooks (updated_at, id)
    WHERE url_state IS NULL OR url_state = 'legacy_pending';

CREATE OR REPLACE FUNCTION classify_outbound_webhook_destination_storage()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.url_state = 'invalid' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.url IS DISTINCT FROM OLD.url
       AND NEW.url_envelope IS NOT DISTINCT FROM OLD.url_envelope
    THEN
        NEW.url_state := 'legacy_pending';
        RETURN NEW;
    END IF;
    IF NEW.url_envelope IS NOT NULL
       AND octet_length(NEW.url_envelope) > 0
       AND NEW.url_state = 'ready'
    THEN
        RETURN NEW;
    END IF;
    NEW.url_state := 'legacy_pending';
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS outbound_webhook_destination_storage_classifier
    ON outbound_webhooks;
CREATE TRIGGER outbound_webhook_destination_storage_classifier
BEFORE INSERT OR UPDATE OF url, url_envelope, url_state
ON outbound_webhooks
FOR EACH ROW
EXECUTE FUNCTION classify_outbound_webhook_destination_storage();

CREATE OR REPLACE FUNCTION postwave_pause_delivery_for_destination_state()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    destination_state text;
BEGIN
    SELECT COALESCE(url_state, 'legacy_pending')
      INTO destination_state
      FROM outbound_webhooks
     WHERE id = NEW.webhook_id
       AND tenant_id = NEW.tenant_id;
    IF destination_state IS DISTINCT FROM 'ready' THEN
        NEW.next_attempt_at := NULL;
        NEW.url_paused_at := COALESCE(NEW.url_paused_at, now());
        NEW.lease_owner := NULL;
        NEW.lease_expires_at := NULL;
    END IF;
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS outbound_webhook_delivery_destination_pause
    ON outbound_webhook_deliveries;
CREATE TRIGGER outbound_webhook_delivery_destination_pause
BEFORE INSERT ON outbound_webhook_deliveries
FOR EACH ROW
EXECUTE FUNCTION postwave_pause_delivery_for_destination_state();

COMMENT ON COLUMN outbound_webhooks.url IS
    'Value-free destination display projection only once url_state=ready.';
COMMENT ON COLUMN outbound_webhooks.url_envelope IS
    'Envelope-encrypted complete receiver URL, including path/query capabilities.';
COMMENT ON COLUMN outbound_webhooks.url_state IS
    'NULL/legacy_pending | ready | invalid; non-ready destinations never deliver.';
COMMENT ON COLUMN outbound_webhook_deliveries.url_paused_at IS
    'Attempt held until its destination URL is envelope-backed and valid.';
