-- 0192_audit_pr234.sql
--
-- Refined Audit log PRs 2-4. Closes the saved-views + retention-
-- editor deferred items from PR 1.
--
--   audit_saved_views — operator-defined named filter sets so a
--     compliance reviewer can re-run the same query on a cadence
--     without re-typing the form. Stored per-tenant; any admin can
--     load + use anyone else's view (audits are a team sport). The
--     filter blob is JSONB so the schema doesn't need a migration
--     every time we add a new filter column.
--
--   audit_retention_days on tenants — operator-editable retention
--     window. The existing audit/trim.go worker reads it on each
--     tick and trims rows older than the window. NULL = use the
--     deployment default (currently 90 days).

CREATE TABLE IF NOT EXISTS audit_saved_views (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    name          text NOT NULL,
    description   text NOT NULL DEFAULT '',
    filters       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid NULL,
    UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS audit_saved_views_tenant_idx
    ON audit_saved_views (tenant_id, updated_at DESC);

-- Tenant-level retention override. Most tenants use the deployment
-- default (the trim worker has a global RETAIN_DAYS env); admins can
-- ramp up (e.g., 365 days for SOC 2) or down (e.g., 30 days for
-- privacy-sensitive verticals) on a per-tenant basis.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS audit_retention_days integer NULL;
