-- 0127_agency_multitenant.sql
--
-- Agency / whitelabel / reseller multi-tenancy.
--
-- An "agency" tenant is a normal tenant row that owns one or more
-- "sub-account" tenants. The relationship is a self-reference on the
-- tenants table (parent_tenant_id), which keeps every existing query —
-- RLS policies, audit logs, billing — working without change. We do
-- NOT add a second table; the parent IS a tenant, just with the
-- is_agency_account flag set.
--
-- Why self-reference rather than a separate `agencies` table:
--   * Every tenant-scoped feature (campaigns, subscribers, audit,
--     billing) already keys off tenants.id. A separate agencies table
--     would force a JOIN everywhere.
--   * Agencies often want their OWN sending identity too (the agency
--     itself sends invoices, marketing). Sharing the schema makes that
--     free.
--   * The flag costs one bool per row; the parent_tenant_id costs one
--     UUID. Both fit on the existing row without expanding any hot
--     index.
--
-- Whitelabel + billing:
--   * billing_mode = 'self' (default, child pays directly via Stripe)
--                  | 'parent' (agency consolidates — child's Stripe IDs
--                              are ignored, parent invoiced for all
--                              children).
--   * whitelabel_* columns hold the per-tenant branded portal config
--     (custom domain, logo URL, primary color hex, support email,
--     legal entity override). When a child tenant has these set, the
--     marketing app reads from there instead of the global Postwave
--     defaults.
--
-- RLS:
--   * We DO NOT extend the tenants.tenant_isolation_select policy
--     because it is already PERMISSIVE FOR SELECT USING (true) — every
--     authenticated app session can SELECT any tenant row (this is how
--     slug -> id resolution works in middleware/tenants.go). The agency
--     handlers re-check parent_tenant_id in application code before
--     returning rows to a parent's API session.
--   * A child cannot see its siblings; the agency handler explicitly
--     filters WHERE parent_tenant_id = $current_tenant.
--   * A child can read its own parent's whitelabel branding (the
--     marketing app does this for the login screen). That read is a
--     direct id lookup against the SELECT-permissive tenants policy.

BEGIN;

-- 1) Self-referential parent + agency flag.
ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS parent_tenant_id   uuid REFERENCES tenants(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS is_agency_account  boolean NOT NULL DEFAULT false,
    -- Billing routing. 'self' = child pays own Stripe; 'parent' =
    -- agency pays consolidated. Switching mid-cycle is allowed but
    -- billing.go handles the cutover (we record the change in
    -- audit_log + tenant_billing_modes_history below).
    ADD COLUMN IF NOT EXISTS billing_mode       text NOT NULL DEFAULT 'self'
        CHECK (billing_mode IN ('self','parent'));

-- We index parent_tenant_id because the agency dashboard runs
-- "show me my sub-accounts" on every page load.
CREATE INDEX IF NOT EXISTS idx_tenants_parent
    ON tenants (parent_tenant_id)
    WHERE parent_tenant_id IS NOT NULL;

-- Quick filter: agencies only. Used by the platform-side reseller
-- analytics ("how many agencies, how many seats per agency").
CREATE INDEX IF NOT EXISTS idx_tenants_agency
    ON tenants (is_agency_account)
    WHERE is_agency_account = true;

-- 2) Whitelabel / branded-portal configuration.
--
-- Storing this on the tenants row keeps the join-free path. Every
-- value is nullable so a sub-account can inherit from the parent (the
-- marketing app's resolver walks: child → parent → Postwave default).
ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS whitelabel_enabled        boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS whitelabel_brand_name     text,
    ADD COLUMN IF NOT EXISTS whitelabel_custom_domain  text,
    ADD COLUMN IF NOT EXISTS whitelabel_logo_url       text,
    ADD COLUMN IF NOT EXISTS whitelabel_primary_color  text,  -- e.g. "#1d4ed8"
    ADD COLUMN IF NOT EXISTS whitelabel_support_email  text,
    ADD COLUMN IF NOT EXISTS whitelabel_legal_entity   text;

-- Custom-domain lookup index (the public portal does
-- "WHERE whitelabel_custom_domain = $1 LIMIT 1" on every request to
-- the branded subdomain). Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_tenants_whitelabel_domain
    ON tenants (whitelabel_custom_domain)
    WHERE whitelabel_custom_domain IS NOT NULL;

-- 3) Reseller pricing markup (optional).
--
-- An agency can resell Postwave at a markup. We store the markup as a
-- basis-points integer so floating-point drift can't leak revenue.
-- 0 = no markup; 5000 = 50% markup; 10000 = 2x. The billing
-- aggregator multiplies child usage by (10000 + markup)/10000 when
-- generating the agency invoice.
ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS reseller_markup_bps int NOT NULL DEFAULT 0
        CHECK (reseller_markup_bps >= 0 AND reseller_markup_bps <= 100000);

-- 4) Audit ledger for billing-mode changes. We need a permanent
-- record (regulatory) of who flipped a child from 'self' to 'parent'
-- and when, because that determines who got invoiced for which
-- emails. The audit_log table holds the row-level event; this
-- denormalised table makes the "billing reconciliation" query fast.
CREATE TABLE IF NOT EXISTS tenant_billing_mode_history (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- parent_tenant_id snapshot at the time of the change. Stored so
    -- if the relationship is later severed, the historical record
    -- still tells the reconciliation worker who paid.
    parent_tenant_id uuid,
    prev_mode       text NOT NULL CHECK (prev_mode IN ('self','parent')),
    new_mode        text NOT NULL CHECK (new_mode IN ('self','parent')),
    changed_by      uuid,
    changed_at      timestamptz NOT NULL DEFAULT now(),
    reason          text
);

CREATE INDEX IF NOT EXISTS idx_tenant_billing_mode_history_tenant
    ON tenant_billing_mode_history (tenant_id, changed_at DESC);

GRANT SELECT, INSERT ON tenant_billing_mode_history TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE tenant_billing_mode_history_id_seq TO postwave_app;

ALTER TABLE tenant_billing_mode_history ENABLE ROW LEVEL SECURITY;
-- The history is visible to:
--   * The tenant itself (its own row), AND
--   * The CURRENT parent tenant of that row's target (NOT a historical
--     parent — once Unlink severs the relationship, the former parent
--     loses read access).
--
-- The EXISTS join to live tenants is the critical bit. The
-- parent_tenant_id column on the history row is a SNAPSHOT for
-- billing-reconciliation purposes; using it directly in the policy
-- would mean a former parent retains read access forever after
-- Unlink. We instead check that the agency relationship is still
-- live by joining to tenants — when Unlink sets
-- tenants.parent_tenant_id = NULL, the former parent's SELECT
-- immediately stops returning that child's history.
CREATE POLICY tenant_visible ON tenant_billing_mode_history AS PERMISSIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR EXISTS (
            SELECT 1 FROM tenants t
             WHERE t.id = tenant_billing_mode_history.tenant_id
               AND t.parent_tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        )
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR EXISTS (
            SELECT 1 FROM tenants t
             WHERE t.id = tenant_billing_mode_history.tenant_id
               AND t.parent_tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        )
    );

-- 5) Aggregated agency usage view. The billing aggregator hits this
-- when generating the agency-consolidated invoice. We materialise it
-- as a view (not a MV) because the row count is small (agency child
-- counts cap in the thousands per parent) and we want it
-- transaction-fresh.
CREATE OR REPLACE VIEW agency_child_usage_v AS
SELECT
    p.id            AS parent_tenant_id,
    p.slug          AS parent_slug,
    c.id            AS child_tenant_id,
    c.slug          AS child_slug,
    c.tier          AS child_tier,
    c.billing_mode  AS child_billing_mode,
    c.reseller_markup_bps AS child_reseller_markup_bps,
    c.created_at    AS child_created_at
  FROM tenants p
  JOIN tenants c ON c.parent_tenant_id = p.id
 WHERE p.is_agency_account = true;

GRANT SELECT ON agency_child_usage_v TO postwave_app;

COMMIT;
