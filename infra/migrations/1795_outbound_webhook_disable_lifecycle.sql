-- 1795_outbound_webhook_disable_lifecycle.sql
-- rollback-strategy: expand-contract
-- rollback-details: retain additive diagnostic/pause columns and the insert
-- trigger. Older binaries ignore the fields; forward workers resume paused
-- rows after an operator re-enables the webhook.
--
-- Auto-disable previously flipped only outbound_webhooks.active. Already
-- queued rows remained due and the lease query ignored the parent state, so a
-- supposedly disabled endpoint kept receiving traffic. A later in-flight
-- success also erased the failure counter used to diagnose auto-disable.
-- Persist the reason and pause queued work atomically.

ALTER TABLE outbound_webhooks
    ADD COLUMN IF NOT EXISTS disabled_reason text,
    ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

ALTER TABLE outbound_webhook_deliveries
    ADD COLUMN IF NOT EXISTS disabled_paused_at timestamptz;

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'outbound_webhooks'::regclass
           AND conname = 'outbound_webhooks_disabled_reason_check'
    ) THEN
        ALTER TABLE outbound_webhooks
            ADD CONSTRAINT outbound_webhooks_disabled_reason_check
            CHECK (
                disabled_reason IS NULL
                OR disabled_reason IN ('manual', 'auto_failures')
            )
            NOT VALID;
    END IF;
END
$migration$;

ALTER TABLE outbound_webhooks
    VALIDATE CONSTRAINT outbound_webhooks_disabled_reason_check;

CREATE INDEX CONCURRENTLY IF NOT EXISTS outbound_webhook_deliveries_disabled_paused_idx
    ON outbound_webhook_deliveries (webhook_id, created_at, id)
    WHERE status = 'pending' AND disabled_paused_at IS NOT NULL;

CREATE OR REPLACE FUNCTION postwave_pause_delivery_for_inactive_webhook()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    webhook_active boolean;
BEGIN
    SELECT active
      INTO webhook_active
      FROM outbound_webhooks
     WHERE id = NEW.webhook_id
       AND tenant_id = NEW.tenant_id;

    IF webhook_active IS DISTINCT FROM true THEN
        NEW.next_attempt_at := NULL;
        NEW.disabled_paused_at := COALESCE(NEW.disabled_paused_at, now());
        NEW.lease_owner := NULL;
        NEW.lease_expires_at := NULL;
    END IF;
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS outbound_webhook_delivery_inactive_pause
    ON outbound_webhook_deliveries;
CREATE TRIGGER outbound_webhook_delivery_inactive_pause
BEFORE INSERT ON outbound_webhook_deliveries
FOR EACH ROW
EXECUTE FUNCTION postwave_pause_delivery_for_inactive_webhook();

COMMENT ON COLUMN outbound_webhooks.disabled_reason IS
    'manual | auto_failures; NULL while active or for pre-migration legacy state.';
COMMENT ON COLUMN outbound_webhooks.disabled_at IS
    'When delivery was deliberately paused; preserved for operator diagnosis.';
COMMENT ON COLUMN outbound_webhook_deliveries.disabled_paused_at IS
    'Pending delivery held because the parent webhook is inactive.';
