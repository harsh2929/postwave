-- 1791_inbound_webhook_secret_maintenance.sql
-- rollback-strategy: expand-contract
-- rollback-details: keep the additive state column, trigger, index, and worker
-- RLS policies on application rollback. Rewrapped secrets must never be
-- downgraded to plaintext. Restore the forward application to resume the
-- bounded maintenance pass.
--
-- Historical inbound webhook signing secrets can predate envelope storage.
-- Classify those rows explicitly so the application worker can envelope-wrap
-- them without an unbounded SQL/KMS migration. The same worker clears expired
-- rotation-grace material. A write trigger catches plaintext rows created or
-- rotated by an older application replica during a rolling deployment.

ALTER TABLE inbound_webhook_endpoints
    ADD COLUMN IF NOT EXISTS secret_storage_state text;

ALTER TABLE inbound_webhook_endpoints
    ALTER COLUMN secret_storage_state SET DEFAULT 'legacy_pending';

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'inbound_webhook_endpoints'::regclass
           AND conname = 'inbound_webhook_endpoints_secret_storage_state_check'
    ) THEN
        ALTER TABLE inbound_webhook_endpoints
            ADD CONSTRAINT inbound_webhook_endpoints_secret_storage_state_check
            CHECK (
                secret_storage_state IS NULL
                OR secret_storage_state IN ('ready', 'legacy_pending', 'invalid')
            )
            NOT VALID;
    END IF;
END
$migration$;

ALTER TABLE inbound_webhook_endpoints
    VALIDATE CONSTRAINT inbound_webhook_endpoints_secret_storage_state_check;

CREATE INDEX IF NOT EXISTS inbound_webhook_endpoints_secret_maintenance_idx
    ON inbound_webhook_endpoints (created_at, id)
    WHERE secret_storage_state IS NULL
       OR secret_storage_state = 'legacy_pending';

CREATE OR REPLACE FUNCTION classify_inbound_webhook_secret_storage()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.secret_storage_state = 'invalid' THEN
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

DROP TRIGGER IF EXISTS inbound_webhook_secret_storage_classifier
    ON inbound_webhook_endpoints;
CREATE TRIGGER inbound_webhook_secret_storage_classifier
BEFORE INSERT OR UPDATE OF secret, secret_envelope, secret_storage_state
ON inbound_webhook_endpoints
FOR EACH ROW
EXECUTE FUNCTION classify_inbound_webhook_secret_storage();

-- The original RESTRICTIVE tenant boundary excluded maintenance workers even
-- after app.outbox_worker was transaction-locally bound. Admit that scope at
-- the boundary, then use narrow PERMISSIVE SELECT/UPDATE policies as the
-- actual worker grants. Tenant-visible access remains unchanged.
DROP POLICY IF EXISTS tenant_isolation ON inbound_webhook_endpoints;
CREATE POLICY inbound_webhook_endpoints_boundary
    ON inbound_webhook_endpoints
    AS RESTRICTIVE
    FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
    );

CREATE POLICY inbound_webhook_endpoints_worker_select
    ON inbound_webhook_endpoints
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (COALESCE(current_setting('app.outbox_worker', true), '') = 'true');

CREATE POLICY inbound_webhook_endpoints_worker_update
    ON inbound_webhook_endpoints
    AS PERMISSIVE
    FOR UPDATE
    TO postwave_app
    USING (COALESCE(current_setting('app.outbox_worker', true), '') = 'true')
    WITH CHECK (COALESCE(current_setting('app.outbox_worker', true), '') = 'true');

ALTER TABLE inbound_webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_webhook_endpoints FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN inbound_webhook_endpoints.secret_storage_state IS
    'NULL/legacy_pending | ready | invalid; production maintenance envelope-wraps every pending secret.';
