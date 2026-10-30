-- 0475_subscriber_dedupe_settings.sql
--
-- SUB-021 — Adjustable auto-merge confidence threshold (per-workspace).
--
-- The DuplicatesModal already ships a complete threshold slider (0.80–1.00)
-- backed by localStorage. The gap is purely server-side: the threshold was
-- client-only, so it could not drive server-side filtering of the duplicate
-- pairs and it did not persist per workspace (every operator's browser had
-- its own value, and a fresh device reset to the default).
--
-- This migration establishes a dedicated, tenant-scoped settings table that
-- holds at most one row per tenant: the operator-set merge confidence
-- threshold. The duplicate-pair list endpoint reads this threshold and drops
-- pairs whose confidence falls below it before serialising, so the client
-- payload shrinks and the threshold is authoritative across devices.
--
-- The threshold is a numeric(4,3) constrained to [0,1] (the UI exposes
-- 0.80–1.00, but the column accepts the full probability range so future
-- heuristics can surface lower-confidence pairs). Default 0.95 matches the
-- historic hardcoded auto-merge bar in DuplicatesModal.tsx.
--
-- Tenant-scoped table -> tenant_id uuid + RLS, with the GUC read via
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid so an unset GUC
-- does not crash the policy. Shape copied from
-- 0463_tenant_identifier_transforms.sql / 0450_tenant_custom_field_settings.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_dedupe_settings (
    id                        uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Operator-set filter threshold. Pairs whose confidence is below this are
    -- hidden from the duplicates list. Default 0.95 = historic auto-merge bar.
    merge_confidence_threshold numeric(4,3) NOT NULL DEFAULT 0.95,
    created_at                timestamptz  NOT NULL DEFAULT now(),
    updated_at                timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT tenant_dedupe_settings_threshold_chk
        CHECK (merge_confidence_threshold >= 0 AND merge_confidence_threshold <= 1)
);

-- At most one settings row per tenant. Drives the upsert used by the admin
-- PUT endpoint (ON CONFLICT (tenant_id) DO UPDATE).
CREATE UNIQUE INDEX IF NOT EXISTS tenant_dedupe_settings_tenant_idx
    ON tenant_dedupe_settings (tenant_id);

CREATE TRIGGER tenant_dedupe_settings_set_updated_at
    BEFORE UPDATE ON tenant_dedupe_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_dedupe_settings TO postwave_app;

ALTER TABLE tenant_dedupe_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_dedupe_settings FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_dedupe_settings
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
