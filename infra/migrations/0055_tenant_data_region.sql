-- 0055_tenant_data_region.sql
--
-- Per-tenant data residency. Enterprise + GDPR Article 44 buyers require
-- a guarantee that their data lives in a specific geographic region.
-- We pin the region at provisioning. Changing it later is not a column
-- write — it requires a coordinated tenant migration job that drains
-- queues, snapshots Postgres, and re-homes blob storage. That job is
-- explicitly out of scope here; this migration only adds the column
-- the UI and middleware read from.
--
-- The middleware in apps/api/internal/regions/middleware.go compares
-- the deployment region (env POSTWAVE_DEPLOYMENT_REGION on each API
-- instance) against this column on every tenant-scoped request and
-- returns 421 Misdirected Request with a Location header when they
-- disagree, so an EU tenant calling our us-east-1 host gets steered
-- to eu-central-1.api.postwave.com without leaking data into the
-- wrong region's logs.

BEGIN;

ALTER TABLE tenants
    ADD COLUMN data_region text NOT NULL DEFAULT 'us-east-1'
        CHECK (data_region IN ('us-east-1','us-west-2','eu-central-1','eu-west-1','ap-southeast-1','ap-northeast-1'));

COMMENT ON COLUMN tenants.data_region IS
    'Authoritative region for this tenant''s data. Set at provisioning. Changing requires a tenant migration job (out of scope for this column — UI is read-only for non-admins).';

COMMIT;
