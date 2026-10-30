-- 0337_deliverability_hub_rls_fixup.sql
--
-- Fifth round of the RESTRICTIVE-only RLS bug pattern (after 0077,
-- 0078, 0329, 0336). 0336 enumerated and fixed 13 offenders found by
-- scripts/check-rls-policies.sh but landed in the same batch as
-- 0334_deliverability_hub_tables.sql, which introduced two NEW
-- offenders that 0336's enumeration could not have seen at write
-- time:
--
--   * deliverability_hub_snapshots    (0334)
--   * deliverability_repair_overrides (0334)
--
-- Both ship `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`
-- + a single RESTRICTIVE `tenant_isolation` policy. Under those flags,
-- with no PERMISSIVE companion, postwave_app gets 42501
-- (row-violates-policy) on every SELECT/INSERT/UPDATE/DELETE — the
-- exact silent-deny pattern the 0077/0078/0329/0336 fixups exist to
-- prevent.
--
-- This migration also unblocks the new `rls-policy-check` required CI
-- gate (Phase 1 `p1-rls-ci-gate`), which lints the migration tree for
-- this antipattern and would otherwise stay red on main.
--
-- Postgres PERMISSIVE/RESTRICTIVE semantics refresher (kept terse,
-- 0336's header has the long version):
--   * PERMISSIVE policies are ORed; a row is visible iff at least one
--     PERMISSIVE policy returns true.
--   * RESTRICTIVE policies are ANDed on top of the PERMISSIVE OR; they
--     filter further but DO NOT GRANT access on their own.
--
-- Fix mirrors 0077/0078/0336: add a canonical PERMISSIVE `tenant_visible`
-- policy that lets `postwave_app` see rows whose `tenant_id` matches the
-- `app.tenant_id` GUC. The existing RESTRICTIVE `tenant_isolation`
-- policies (which also honour `app.outbox_worker = 'true'` for the
-- deliverability hub worker bypass) are intentionally left in place as
-- the defence-in-depth filter against cross-tenant writes.
--
-- Predicate form uses the cast-to-text + COALESCE-on-nil-UUID idiom
-- pioneered in 0174/0176/0178/0179 and re-used by 0336, so an unset
-- `app.tenant_id` GUC simply evaluates to "no rows visible" instead
-- of crashing on the raw `::uuid` cast.
--
-- Idempotent: every policy is wrapped in DROP POLICY IF EXISTS so this
-- migration is safe to re-apply on tenants that already received a
-- hand-patched fix between 0336 and 0337.

BEGIN;

-- ---------------------------------------------------------------------
-- deliverability_hub_snapshots (from 0334)
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_visible ON deliverability_hub_snapshots;
CREATE POLICY tenant_visible ON deliverability_hub_snapshots
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

-- ---------------------------------------------------------------------
-- deliverability_repair_overrides (from 0334)
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_visible ON deliverability_repair_overrides;
CREATE POLICY tenant_visible ON deliverability_repair_overrides
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text))
    WITH CHECK (tenant_id::text = COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '00000000-0000-0000-0000-000000000000'::text));

COMMIT;
