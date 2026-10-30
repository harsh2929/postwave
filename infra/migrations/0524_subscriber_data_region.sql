-- 0524_subscriber_data_region.sql
--
-- SUB-052: region-pinned data residency per tenant, extended to a
-- per-subscriber override. Tenant-level residency already exists
-- (tenants.data_region, migration 0055) with full regions
-- infrastructure (endpoint routing, EnforceRegion middleware, ESP
-- region pinning). The only missing piece is a per-subscriber override
-- so a single EU-resident profile inside an otherwise US-pinned tenant
-- can be pinned to an EU data plane (backups + sub-processor selection)
-- without splitting the whole tenant.
--
-- The column is NULLABLE: NULL means "inherit the owning tenant's
-- region" (the common case — most subscribers want their tenant's
-- residency). A non-NULL value is the explicit per-subscriber override.
-- The effective region is resolved in Go by
-- regions.InheritedRegionFor(subscriber_region, tenant_region), which
-- the backup/sub-processor selection path consults.
--
-- The CHECK mirrors tenants.data_region (0055) but additionally admits
-- NULL — keep this list in lockstep with regions.Allowed() and the
-- 0055 tenant constraint. Adding a region is a coordinated rollout
-- (new regions.go constant + extend BOTH CHECK constraints + new
-- infra). No backfill: existing rows stay NULL and inherit, which is
-- exactly the pre-migration behaviour.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS data_region text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'subscribers_data_region_chk'
    ) THEN
        ALTER TABLE subscribers
            ADD CONSTRAINT subscribers_data_region_chk
            CHECK (data_region IS NULL OR data_region IN (
                'us-east-1',
                'us-west-2',
                'eu-central-1',
                'eu-west-1',
                'ap-southeast-1',
                'ap-northeast-1'
            ));
    END IF;
END$$;

COMMENT ON COLUMN subscribers.data_region IS
    'SUB-052 per-subscriber data-residency override. NULL inherits the '
    'owning tenant''s data_region (0055). Resolved via '
    'regions.InheritedRegionFor for backup/sub-processor selection.';

-- Partial index: only the (rare) override rows. Lets the residency
-- reconciler / backup-router scan "which subscribers are pinned off the
-- tenant default" cheaply without touching the NULL-inheriting majority.
CREATE INDEX IF NOT EXISTS subscribers_tenant_data_region_idx
    ON subscribers (tenant_id, data_region)
    WHERE data_region IS NOT NULL;

COMMIT;
