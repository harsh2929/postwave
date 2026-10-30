-- 1792_inbound_webhook_trigger_parent_integrity.sql
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Keep the composite unique index and foreign key on
-- application rollback. They only reject trigger rows whose tenant does not
-- own the referenced endpoint and therefore preserve an existing data
-- isolation invariant.
--
-- A trigger previously carried independent tenant_id and webhook_id foreign
-- keys. That allowed a tenant-scoped insert to name another tenant's endpoint
-- when its UUID was known, leaving a cross-tenant row that runtime RLS happened
-- not to execute. Bind both columns in one foreign key so ownership is enforced
-- even for direct SQL and older application replicas during a rolling deploy.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS inbound_webhook_endpoints_tenant_id_id_uidx
    ON inbound_webhook_endpoints (tenant_id, id);

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'inbound_webhook_triggers'::regclass
           AND conname = 'inbound_webhook_triggers_tenant_endpoint_fkey'
    ) THEN
        ALTER TABLE inbound_webhook_triggers
            ADD CONSTRAINT inbound_webhook_triggers_tenant_endpoint_fkey
            FOREIGN KEY (tenant_id, webhook_id)
            REFERENCES inbound_webhook_endpoints (tenant_id, id)
            ON DELETE CASCADE
            NOT VALID;
    END IF;
END
$migration$;

-- Fail the deployment rather than silently deleting or re-homing any
-- historical cross-tenant row. Operators can inspect and deliberately repair
-- such data before retrying the migration.
ALTER TABLE inbound_webhook_triggers
    VALIDATE CONSTRAINT inbound_webhook_triggers_tenant_endpoint_fkey;

COMMIT;
