-- 0335_rls_asset_tags_dmarc_acks.sql
--
-- Phase 0 hardening (p0-rls-asset-tags): close the "tenant_id column but
-- no RLS" gap on asset_tags and dmarc_suggestion_acks, both of which
-- shipped with a tenant_id column on the row but ENABLE ROW LEVEL
-- SECURITY *off*, relying entirely on application-layer tenant scoping.
--
-- Background
-- ----------
-- Two related tables historically went out without table-level RLS:
--
--   * asset_tags (0231_asset_tags.sql) -- the per-row tag join table
--     between assets and free-text tags. The table already carries
--     tenant_id (denormalised from assets), has the right FK to
--     tenants(id) ON DELETE CASCADE, but the migration never issued
--     ENABLE ROW LEVEL SECURITY. Any code path that runs
--     `SELECT ... FROM asset_tags` under the postwave_app role sees
--     every (tenant_id, asset_id, tag) tuple across all tenants -- a
--     cross-tenant brand/asset enumeration leak.
--
--   * dmarc_suggestion_acks (0188_dmarc_suggestion_acks.sql) -- the
--     "operator acknowledged this suggestion" table. The original
--     migration's trailing comment ("RLS lives in the API layer ...
--     no row policy here") explicitly opted out of RLS, deferring
--     enforcement to handler code. The 2026 security sweep treats that
--     as an unacceptable surface: a leaky audit-export query, a
--     vulnerable internal endpoint, or a future debug route could
--     enumerate which DMARC findings each tenant has chosen to
--     suppress -- which is itself security-sensitive intelligence
--     (it reveals which alignment / volume issues a tenant has
--     deliberately ignored).
--
-- Both tables already carry tenant_id, so this migration is purely
-- additive: no schema change, no backfill (tenant_id was NOT NULL from
-- day one for both tables -- see 0231 and 0188), just the missing
-- ENABLE/FORCE RLS + tenant_visible policy.
--
-- Design
-- ------
-- Apply the canonical Postwave tenant-scoped table pattern (matches
-- 0329_remaining_rls_fixup.sql / 0331_force_rls_and_tenant_fk_sweep.sql
-- / 0332_rls_auth_idp_links.sql):
--
--   1. ENABLE ROW LEVEL SECURITY -- turn the policy machinery on.
--   2. FORCE ROW LEVEL SECURITY  -- ensure postwave_owner (migrations,
--      janitors) does NOT bypass policies in production. Without FORCE
--      the table owner role silently becomes cross-tenant, defeating
--      the point of the ENABLE.
--   3. CREATE POLICY tenant_visible -- PERMISSIVE FOR ALL, the canonical
--      "this row belongs to the current GUC tenant" predicate. Uses the
--      cast-to-text + COALESCE-with-nil-uuid idiom so the predicate
--      evaluates cleanly when the GUC is unset (unset GUC -> NULLIF
--      returns NULL -> COALESCE substitutes the nil uuid -> the
--      comparison returns false, denying access by default). This matches
--      0329_remaining_rls_fixup.sql exactly and avoids the raw `::uuid`
--      cast that crashes on an unset GUC (the historical 0077/0078 bug).
--
-- Tenant FK already in place
-- --------------------------
-- asset_tags already has `tenant_id uuid NOT NULL REFERENCES
-- tenants(id) ON DELETE CASCADE` (0231_asset_tags.sql line 13).
-- dmarc_suggestion_acks was created in 0188 without an explicit FK to
-- tenants; we add it here with the standard NOT VALID + VALIDATE split
-- so the catalog entry locks only briefly. The CASCADE is the right
-- semantic: when a tenant is deleted, their DMARC acknowledgement
-- audit trail must go with them (DSAR right-to-erasure).
--
-- Idempotency
-- -----------
-- Every CREATE POLICY is preceded by DROP POLICY IF EXISTS so the
-- migration is safe to re-apply (e.g. against a tenant that received a
-- hand-patched fix between releases). The ENABLE/FORCE RLS statements
-- are no-ops in PG if already set. The FK add is guarded by a catalog
-- existence check.

BEGIN;

-- ---------------------------------------------------------------------
-- asset_tags (from 0231_asset_tags.sql)
-- ---------------------------------------------------------------------
-- tenant_id already exists and already FKs to tenants(id) ON DELETE
-- CASCADE. The only gap is the missing ENABLE/FORCE RLS + policy.

ALTER TABLE asset_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_tags FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_visible ON asset_tags;
CREATE POLICY tenant_visible ON asset_tags
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

-- ---------------------------------------------------------------------
-- dmarc_suggestion_acks (from 0188_dmarc_suggestion_acks.sql)
-- ---------------------------------------------------------------------
-- tenant_id already exists (NOT NULL, see 0188), but the original
-- migration deliberately skipped both the FK to tenants(id) and the
-- RLS policy ("RLS lives in the API layer"). We close both gaps here.

-- Add FK to tenants(id) ON DELETE CASCADE if not already present.
-- NOT VALID + VALIDATE pattern -- the catalog entry locks briefly,
-- then validation runs concurrently with new INSERTs (matches the
-- 0331_force_rls_and_tenant_fk_sweep.sql helper).
DO $$
DECLARE
    v_exists boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_class ft ON ft.oid = con.confrelid
        WHERE c.relname = 'dmarc_suggestion_acks'
          AND n.nspname = current_schema()
          AND con.contype = 'f'
          AND ft.relname = 'tenants'
    ) INTO v_exists;

    IF NOT v_exists THEN
        EXECUTE 'ALTER TABLE dmarc_suggestion_acks
                 ADD CONSTRAINT fk_dmarc_suggestion_acks_tenant
                 FOREIGN KEY (tenant_id) REFERENCES tenants(id)
                 ON DELETE CASCADE NOT VALID';
        EXECUTE 'ALTER TABLE dmarc_suggestion_acks
                 VALIDATE CONSTRAINT fk_dmarc_suggestion_acks_tenant';
    END IF;
END$$;

ALTER TABLE dmarc_suggestion_acks ENABLE ROW LEVEL SECURITY;
ALTER TABLE dmarc_suggestion_acks FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_visible ON dmarc_suggestion_acks;
CREATE POLICY tenant_visible ON dmarc_suggestion_acks
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

COMMIT;
