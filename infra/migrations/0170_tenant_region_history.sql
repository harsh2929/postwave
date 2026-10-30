-- 0170_tenant_region_history.sql
--
-- Closes multi-region audit CRITICAL #2: the regions/migration_handler.go
-- comment promised "the change is logged into audit_log + tenant_region_history"
-- but the table didn't exist. Operators conducting GDPR data-location
-- investigations were trusting code comments that didn't match reality.
--
-- One row per region change: who moved which tenant from where to
-- where, when, and why. The audit_log already carries the same data,
-- but this table is a focused, queryable surface for the specific
-- "show me every cross-region move in the last quarter" question that
-- compliance auditors ask.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_region_history (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    from_region     text        NOT NULL,
    to_region       text        NOT NULL,
    reason          text,
    moved_by_user_id uuid,
    moved_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_region_history_tenant_idx
    ON tenant_region_history (tenant_id, moved_at DESC);
CREATE INDEX IF NOT EXISTS tenant_region_history_moved_at_idx
    ON tenant_region_history (moved_at DESC);

GRANT SELECT, INSERT ON tenant_region_history TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE tenant_region_history_id_seq TO postwave_app;

-- No RLS: region changes are a cross-tenant ops surface that the
-- regional-migration handler operates without a tenant context.
-- Read access in the dashboard is gated by ScopeAdmin at the
-- handler layer.

COMMIT;
