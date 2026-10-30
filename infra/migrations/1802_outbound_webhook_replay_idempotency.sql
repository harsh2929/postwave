-- 1802_outbound_webhook_replay_idempotency.sql
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Keep the nullable evidence columns and partial unique
-- index on application rollback. Older replicas ignore them; removing the
-- index while a newer replica is live would re-introduce duplicate sends.
--
-- Bind every operator replay to a tenant-scoped, one-way digest of the
-- required Idempotency-Key. The replay child itself is the durable receipt:
-- retries return its stable id, source lineage, and replayed_at timestamp.
-- No raw caller-selected key is retained.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE outbound_webhook_deliveries
    ADD COLUMN IF NOT EXISTS replay_idempotency_hash bytea,
    ADD COLUMN IF NOT EXISTS replayed_at timestamptz;

COMMIT;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
    outbound_webhook_deliveries_replay_idempotency_uidx
    ON outbound_webhook_deliveries (tenant_id, replay_idempotency_hash)
    WHERE replay_idempotency_hash IS NOT NULL;

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'outbound_webhook_deliveries'::regclass
           AND conname = 'outbound_webhook_deliveries_replay_receipt_check'
    ) THEN
        ALTER TABLE outbound_webhook_deliveries
            ADD CONSTRAINT outbound_webhook_deliveries_replay_receipt_check
            CHECK (
                replay_idempotency_hash IS NULL
                OR (
                    octet_length(replay_idempotency_hash) = 32
                    AND parent_delivery_id IS NOT NULL
                    AND replayed_at IS NOT NULL
                )
            )
            NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'outbound_webhook_deliveries'::regclass
           AND conname = 'outbound_webhook_deliveries_replayed_at_check'
    ) THEN
        ALTER TABLE outbound_webhook_deliveries
            ADD CONSTRAINT outbound_webhook_deliveries_replayed_at_check
            CHECK (
                replayed_at IS NULL
                OR parent_delivery_id IS NOT NULL
            )
            NOT VALID;
    END IF;
END
$migration$;

ALTER TABLE outbound_webhook_deliveries
    VALIDATE CONSTRAINT outbound_webhook_deliveries_replay_receipt_check;

ALTER TABLE outbound_webhook_deliveries
    VALIDATE CONSTRAINT outbound_webhook_deliveries_replayed_at_check;

COMMENT ON COLUMN outbound_webhook_deliveries.replay_idempotency_hash IS
    'SHA-256 domain/tenant-bound digest of the operator replay Idempotency-Key; raw keys are never retained.';

COMMENT ON COLUMN outbound_webhook_deliveries.replayed_at IS
    'Frozen creation timestamp returned for every retry of one logical operator replay.';

COMMIT;
