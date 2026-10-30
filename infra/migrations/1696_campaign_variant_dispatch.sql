-- 1696_campaign_variant_dispatch.sql
--
-- Make campaign A/B variants part of the real send pipeline.  The original
-- A/B tables stored variant copy and aggregate counters, but recipient rows
-- had no variant identity.  Consequently every queued recipient received the
-- parent campaign body and campaign_variant_results could never be populated
-- from authoritative delivery data.

BEGIN;

ALTER TABLE campaign_recipients
    ADD COLUMN IF NOT EXISTS variant_id uuid
        REFERENCES campaign_variants(id) ON DELETE SET NULL;

COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_recipients_variant_idx
    ON campaign_recipients (tenant_id, variant_id)
    WHERE variant_id IS NOT NULL;
