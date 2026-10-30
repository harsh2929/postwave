-- 0536_dsar_policies.sql
--
-- SUB-053 — DSAR fan-out automation across stores (policy table).
--
-- Why this migration:
--   The per-subscriber Subject Access Request surface (apps/api/internal/sar)
--   bundles everything Postwave itself holds about a data subject, but a
--   modern DSAR must also fan out to every connected commerce store
--   (Shopify / WooCommerce / Stripe / Square — enumerated from
--   commerce_integrations, migration 0028) and either RETURN the store's copy
--   of the subject's data or DELETE/anonymise it, depending on the operator's
--   policy for that provider.
--
--   This migration creates the dsar_policies table: one row per
--   (tenant_id, provider) declaring whether a fan-out to that provider should
--   be return-only (export the data) or auto-delete (issue the provider's
--   erasure/anonymise call), whether an explicit operator acknowledgement is
--   required before a destructive action runs, and an optional expiry after
--   which the policy reverts to the conservative return-only default.
--
--   A tenant with no row for a provider falls back to the safe default
--   ('return_only', no auto-delete) — fan-out never destroys data a tenant
--   has not explicitly opted into deleting.
--
-- rollback-strategy: additive. Hard rollback = DROP TABLE dsar_policies.

BEGIN;

CREATE TABLE IF NOT EXISTS dsar_policies (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The four commerce providers a fan-out can target. Mirrors the
    -- commerce_integrations.provider CHECK (migration 0028) so a policy can
    -- never name a provider the integrations table cannot hold.
    provider      text NOT NULL CHECK (provider IN (
                      'shopify', 'woocommerce', 'stripe', 'square'
                  )),
    -- return_only  -> export the subject's store data into the SAR bundle.
    -- auto_delete  -> additionally issue the provider's delete/anonymise call
    --                 and capture the deletion proof.
    policy_type   text NOT NULL DEFAULT 'return_only' CHECK (policy_type IN (
                      'return_only', 'auto_delete'
                  )),
    -- Denormalised convenience flag mirroring policy_type = 'auto_delete'.
    -- Kept as its own column so a send-time check is a single boolean read.
    auto_delete   boolean NOT NULL DEFAULT false,
    -- When true, a destructive (auto_delete) fan-out is held until an operator
    -- explicitly acknowledges — the orchestrator records the store as
    -- 'ack_required' rather than issuing the delete.
    ack_required  boolean NOT NULL DEFAULT false,
    -- Optional expiry: after this passes the policy is treated as the
    -- conservative return-only default until refreshed. NULL = never expires.
    expires_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    -- One policy per (tenant, provider) — the dominant lookup shape.
    UNIQUE (tenant_id, provider)
);

COMMENT ON TABLE dsar_policies IS
    'SUB-053 per-(tenant,provider) DSAR fan-out policy: return-only vs auto-delete, ack gate, optional expiry.';

CREATE INDEX IF NOT EXISTS dsar_policies_tenant_idx
    ON dsar_policies (tenant_id, provider);

CREATE TRIGGER dsar_policies_set_updated_at
    BEFORE UPDATE ON dsar_policies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON dsar_policies TO postwave_app;

ALTER TABLE dsar_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE dsar_policies FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON dsar_policies
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON dsar_policies
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
