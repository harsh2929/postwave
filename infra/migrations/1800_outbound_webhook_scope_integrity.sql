-- 1800_outbound_webhook_scope_integrity.sql
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Keep both constraints and the supporting unique index on
-- application rollback. They only reject invalid descriptions and webhook
-- scopes that do not identify a list owned by the same tenant.
--
-- Application writes already validate description length and resolve list_id
-- through list_id_map inside the tenant transaction. Persist the same
-- invariants in PostgreSQL so older replicas, maintenance SQL, or a concurrent
-- mapping deletion cannot create an orphaned/cross-tenant subscription.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS list_id_map_tenant_postwave_uuid_uidx
    ON list_id_map (tenant_id, postwave_uuid);

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'outbound_webhooks'::regclass
           AND conname = 'outbound_webhooks_tenant_list_fkey'
    ) THEN
        ALTER TABLE outbound_webhooks
            ADD CONSTRAINT outbound_webhooks_tenant_list_fkey
            FOREIGN KEY (tenant_id, list_id)
            REFERENCES list_id_map (tenant_id, postwave_uuid)
            NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'outbound_webhooks'::regclass
           AND conname = 'outbound_webhooks_description_length_check'
    ) THEN
        ALTER TABLE outbound_webhooks
            ADD CONSTRAINT outbound_webhooks_description_length_check
            CHECK (
                description IS NULL
                OR char_length(description) <= 512
            )
            NOT VALID;
    END IF;
END
$migration$;

-- Fail rather than silently deleting, widening, or truncating historical
-- endpoint configuration. Operators can inspect and deliberately remediate
-- any violating row before retrying this migration.
ALTER TABLE outbound_webhooks
    VALIDATE CONSTRAINT outbound_webhooks_tenant_list_fkey;

ALTER TABLE outbound_webhooks
    VALIDATE CONSTRAINT outbound_webhooks_description_length_check;

COMMENT ON CONSTRAINT outbound_webhooks_tenant_list_fkey
    ON outbound_webhooks IS
    'A list-scoped endpoint must reference a list mapping owned by the same tenant.';

COMMENT ON CONSTRAINT outbound_webhooks_description_length_check
    ON outbound_webhooks IS
    'Operator-facing endpoint descriptions are bounded to 512 Unicode characters.';

COMMIT;
