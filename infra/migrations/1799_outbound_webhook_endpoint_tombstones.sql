-- 1799_outbound_webhook_endpoint_tombstones.sql
-- rollback-strategy: expand-contract
-- rollback-details: retain deleted_at; old binaries see tombstoned rows as
-- inactive, while forward binaries keep them hidden and purge after retention.
--
-- A user delete must stop delivery immediately without cascading away the
-- diagnostics and replay evidence that explain what happened. Normal reads
-- exclude tombstones; the retention sweeper removes them only after delivery
-- and lifecycle-notification evidence has expired.

ALTER TABLE outbound_webhooks
    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'outbound_webhooks'::regclass
           AND conname = 'outbound_webhooks_tombstone_secret_shredding_check'
    ) THEN
        ALTER TABLE outbound_webhooks
            ADD CONSTRAINT outbound_webhooks_tombstone_secret_shredding_check
            CHECK (
                deleted_at IS NULL
                OR (
                    active = false
                    AND octet_length(secret_envelope) = 0
                    AND secondary_secret_envelope IS NULL
                    AND url_envelope IS NULL
                    AND auth_config_envelope IS NULL
                    AND auth_config_restore_active IS NULL
                    AND url_restore_active IS NULL
                )
            ) NOT VALID;
    END IF;
END
$migration$;

ALTER TABLE outbound_webhooks
    VALIDATE CONSTRAINT outbound_webhooks_tombstone_secret_shredding_check;

CREATE INDEX CONCURRENTLY IF NOT EXISTS outbound_webhooks_deleted_at_idx
    ON outbound_webhooks (tenant_id, deleted_at, id)
    WHERE deleted_at IS NOT NULL;

COMMENT ON COLUMN outbound_webhooks.deleted_at IS
    'Operator deletion tombstone. Hidden from CRUD and permanently ineligible for fanout; purged after dependent evidence retention.';
