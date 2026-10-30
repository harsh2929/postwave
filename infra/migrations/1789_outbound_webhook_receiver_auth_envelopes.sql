-- 1789_outbound_webhook_receiver_auth_envelopes.sql
-- rollback-strategy: expand-contract
-- rollback-details: leave the additive columns/state constraint in place on
-- application rollback. Rewrapped authenticated hooks deliberately fail closed
-- on a legacy binary until the forward release is restored; never downgrade
-- ciphertext to plaintext. Restore the preflight snapshot only for corruption.
--
-- Receiver-side bearer tokens, custom-header values and mTLS private material
-- were historically stored inline in outbound_webhooks.auth_config JSONB.
-- Keep auth_config as value-free operator metadata and move credentials to the
-- platform envelope cipher. Existing non-empty rows are explicitly quarantined
-- until the bounded application rewrap worker encrypts and redacts them.
--
-- This migration is intentionally rerunnable. It does not attempt encryption
-- in SQL because only the application has access to the configured envelope
-- cipher/KMS.

ALTER TABLE outbound_webhooks
    ADD COLUMN IF NOT EXISTS auth_config_envelope bytea,
    ADD COLUMN IF NOT EXISTS auth_config_state text,
    ADD COLUMN IF NOT EXISTS auth_config_restore_active boolean;

ALTER TABLE outbound_webhook_deliveries
    ADD COLUMN IF NOT EXISTS auth_config_paused_at timestamptz;

-- Only classify rows that have not already been processed. A rerun must never
-- move an invalid or successfully rewrapped row back into the pending queue.
UPDATE outbound_webhooks
   SET auth_config_state = CASE
           WHEN auth_config IS NULL OR auth_config = '{}'::jsonb OR auth_config = 'null'::jsonb
               THEN 'ready'
           ELSE 'legacy_pending'
       END,
       auth_config_restore_active = CASE
           WHEN auth_config IS NULL OR auth_config = '{}'::jsonb OR auth_config = 'null'::jsonb
               THEN NULL
           ELSE active
       END,
       active = CASE
           WHEN auth_config IS NULL OR auth_config = '{}'::jsonb OR auth_config = 'null'::jsonb
               THEN active
           ELSE false
       END
 WHERE auth_config_state IS NULL;

-- Quarantine already-queued attempts before any application replica can read
-- a legacy config. A delivery-insert trigger below closes the same race for an
-- old dispatcher with a cached active subscription during a rolling deploy.
UPDATE outbound_webhook_deliveries AS delivery
   SET next_attempt_at = NULL,
       auth_config_paused_at = COALESCE(delivery.auth_config_paused_at, now()),
       lease_owner = NULL,
       lease_expires_at = NULL
  FROM outbound_webhooks AS webhook
 WHERE delivery.webhook_id = webhook.id
   AND delivery.tenant_id = webhook.tenant_id
   AND delivery.status = 'pending'
   AND webhook.auth_config_state = 'legacy_pending';

ALTER TABLE outbound_webhooks
    ALTER COLUMN auth_config_state SET DEFAULT 'ready',
    ALTER COLUMN auth_config_state SET NOT NULL;

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'outbound_webhooks'::regclass
           AND conname = 'outbound_webhooks_auth_config_state_check'
    ) THEN
        ALTER TABLE outbound_webhooks
            ADD CONSTRAINT outbound_webhooks_auth_config_state_check
            CHECK (
                auth_config_state IN ('ready', 'legacy_pending', 'invalid')
                AND (
                    auth_config_envelope IS NULL
                    OR octet_length(auth_config_envelope) BETWEEN 1 AND 262144
                )
                AND (
                    auth_config_state = 'ready'
                    OR auth_config_envelope IS NULL
                )
                AND (
                    auth_config_state = 'ready'
                    OR active = false
                )
            ) NOT VALID;
    END IF;
END
$migration$;

ALTER TABLE outbound_webhooks
    VALIDATE CONSTRAINT outbound_webhooks_auth_config_state_check;

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'outbound_webhooks'::regclass
           AND conname = 'outbound_webhooks_auth_config_metadata_safe_check'
    ) THEN
        ALTER TABLE outbound_webhooks
            ADD CONSTRAINT outbound_webhooks_auth_config_metadata_safe_check
            CHECK (
                auth_config_state <> 'ready'
                OR (
                    (
                        auth_config IS NULL
                        OR auth_config = '{}'::jsonb
                        OR auth_config = 'null'::jsonb
                    )
                    AND auth_config_envelope IS NULL
                )
                OR (
                    jsonb_typeof(auth_config) = 'object'
                    AND COALESCE(auth_config->>'type', '') = 'encrypted'
                    AND auth_config_envelope IS NOT NULL
                    AND NOT (
                        auth_config ?| ARRAY[
                            'bearer_token',
                            'headers',
                            'mtls_cert_pem',
                            'mtls_key_pem'
                        ]
                    )
                )
            ) NOT VALID;
    END IF;
END
$migration$;

ALTER TABLE outbound_webhooks
    VALIDATE CONSTRAINT outbound_webhooks_auth_config_metadata_safe_check;

CREATE INDEX IF NOT EXISTS outbound_webhooks_auth_rewrap_pending_idx
    ON outbound_webhooks (updated_at, id)
    WHERE auth_config_state = 'legacy_pending';

-- A pre-upgrade API process cannot understand auth_config_envelope. The
-- persisted metadata deliberately uses type=encrypted so its legacy decoder
-- errors rather than delivering without receiver auth. These triggers cover
-- its two possible writes during a rolling deployment:
--   * reject plaintext auth_config via the metadata constraint above;
--   * keep deliveries paused while a webhook is non-ready.
CREATE OR REPLACE FUNCTION postwave_pause_delivery_for_receiver_auth()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    receiver_auth_state text;
BEGIN
    SELECT auth_config_state
      INTO receiver_auth_state
      FROM outbound_webhooks
     WHERE id = NEW.webhook_id
       AND tenant_id = NEW.tenant_id;

    IF receiver_auth_state IS DISTINCT FROM 'ready' THEN
        NEW.next_attempt_at := NULL;
        NEW.auth_config_paused_at := COALESCE(NEW.auth_config_paused_at, now());
        NEW.lease_owner := NULL;
        NEW.lease_expires_at := NULL;
    END IF;
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS outbound_webhook_delivery_receiver_auth_pause
    ON outbound_webhook_deliveries;
CREATE TRIGGER outbound_webhook_delivery_receiver_auth_pause
BEFORE INSERT ON outbound_webhook_deliveries
FOR EACH ROW
EXECUTE FUNCTION postwave_pause_delivery_for_receiver_auth();

CREATE OR REPLACE FUNCTION postwave_clear_legacy_receiver_auth_envelope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF OLD.auth_config_state = 'ready'
       AND (
           NEW.auth_config IS NULL
           OR NEW.auth_config = '{}'::jsonb
           OR NEW.auth_config = 'null'::jsonb
       )
       AND NEW.auth_config IS DISTINCT FROM OLD.auth_config
       AND NEW.auth_config_envelope IS NOT DISTINCT FROM OLD.auth_config_envelope
    THEN
        NEW.auth_config_envelope := NULL;
    END IF;
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS outbound_webhook_legacy_auth_clear
    ON outbound_webhooks;
CREATE TRIGGER outbound_webhook_legacy_auth_clear
BEFORE UPDATE OF auth_config ON outbound_webhooks
FOR EACH ROW
EXECUTE FUNCTION postwave_clear_legacy_receiver_auth_envelope();

-- Keep the existing app.outbox_worker SELECT/UPDATE policies from migration
-- 0088 in force for the rewrap worker. FORCE prevents table ownership from
-- accidentally bypassing that boundary.
ALTER TABLE outbound_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_webhooks FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN outbound_webhooks.auth_config IS
    'Value-free receiver-auth metadata only; credential values are forbidden.';
COMMENT ON COLUMN outbound_webhooks.auth_config_envelope IS
    'Envelope-encrypted receiver bearer/custom-header/mTLS credential JSON.';
COMMENT ON COLUMN outbound_webhooks.auth_config_state IS
    'ready | legacy_pending | invalid; non-ready receiver auth fails delivery closed.';
COMMENT ON COLUMN outbound_webhooks.auth_config_restore_active IS
    'Pre-migration active state restored only after receiver auth is safely rewrapped.';
COMMENT ON COLUMN outbound_webhook_deliveries.auth_config_paused_at IS
    'Attempt was held while receiver credentials were legacy_pending or invalid.';
