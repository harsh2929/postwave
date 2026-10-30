-- 1786_outbound_webhook_replay_lineage.sql
--
-- Replays are new deliveries, not mutations of the original attempt. Keep an
-- explicit lineage pointer so operators can audit why a second delivery was
-- sent while retaining the original response/error history intact.

BEGIN;

ALTER TABLE outbound_webhook_deliveries
    ADD COLUMN IF NOT EXISTS parent_delivery_id uuid;

-- Keep lineage identity immutable even after the original delivery ages out.
-- A self-FK with ON DELETE SET NULL is unsafe here: several replay children
-- may legally share one source_event_id while parented, but nulling them turns
-- them into duplicate "root" rows under migration 1788's unique predicate.
-- ReplayDelivery validates and copies the parent inside one tenant transaction,
-- so referential integrity is established at creation time without making
-- retention mutate or erase historical lineage.
ALTER TABLE outbound_webhook_deliveries
    DROP CONSTRAINT IF EXISTS outbound_webhook_deliveries_parent_delivery_id_fkey;

CREATE INDEX IF NOT EXISTS outbound_webhook_deliveries_parent_idx
    ON outbound_webhook_deliveries (tenant_id, parent_delivery_id)
    WHERE parent_delivery_id IS NOT NULL;

COMMIT;
