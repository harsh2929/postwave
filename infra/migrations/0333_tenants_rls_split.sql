-- 0333_tenants_rls_split.sql
--
-- Phase 0 hardening (p0-rls-tenants-resolver): narrow the historically
-- wide-open SELECT policy on `tenants` so that the postwave_app role
-- can only see the *current* tenant's row by default, and only sees
-- other tenants' rows when it explicitly opts into the pre-tenant
-- resolver path via `SET LOCAL app.tenant_resolver = 'true'`.
--
-- Background
-- ----------
-- 0001_init_tenants.sql introduced the tenants table with this SELECT
-- policy:
--
--     CREATE POLICY tenant_isolation_select ON tenants
--         AS PERMISSIVE FOR SELECT
--         USING (true);
--
-- The original justification was the bootstrap problem: the tenant
-- middleware needs to translate an inbound `X-Tenant-Slug` (or API key
-- tenant id, or session.tenant_id) into a tenants.row BEFORE it can
-- bind `app.tenant_id`. Tightening the policy to
-- `id = current_setting('app.tenant_id')::uuid` would have created a
-- chicken-and-egg failure for the slug-lookup site.
--
-- The 2026 security sweep flagged this as a real cross-tenant read
-- surface: any code path that runs `SELECT ... FROM tenants` under the
-- postwave_app role -- intentionally or by accident -- sees every
-- tenant in the system (id, slug, name, tier, billing_mode, data_region,
-- whitelabel_custom_domain, hipaa_baa_signed, parent_tenant_id, ...).
-- A leaky query, a vulnerable third-party handler, or a future debug
-- endpoint can quietly enumerate the whole tenant table.
--
-- Design
-- ------
-- Split the SELECT policy into two narrower permissive policies. A row
-- is visible iff at least one returns true (PERMISSIVE = ORed):
--
--   1. tenant_resolver_select - PERMISSIVE FOR SELECT
--        Gate: current_setting('app.tenant_resolver', true) = 'true'
--        Used by the tiny pre-tenant resolution window where we don't
--        yet know which tenant the request belongs to:
--          * middleware/tenant.go: slug -> id (X-Tenant-Slug header)
--          * apikeys/middleware.go: API-key tenant id -> tenants row
--          * compat/popups_public.go: public popup slug -> id
--          * replies/repo.go: inbound reply-by-slug routing
--          * tenants/admin_handlers.go: internal slug -> id for cascade-
--            delete (runs before any tenant context binding)
--        These call sites all set `app.tenant_resolver = 'true'` on the
--        transaction (mirroring the existing app.auth_resolver pattern
--        in auth/repo.go withResolverGUC). Outside that window the GUC
--        is unset and the policy returns false.
--
--   2. tenant_isolation_select - PERMISSIVE FOR SELECT
--        Gate: id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
--        Standard per-tenant queries. Once the resolver has bound
--        app.tenant_id, every other tenants-row read collapses to the
--        single owning row -- the chicken-and-egg is resolved at the
--        layer above (in Go), not here.
--
-- The companion AfterRelease hook in apps/api/internal/db/db.go is
-- updated to RESET app.tenant_resolver alongside the other worker
-- GUCs, so a misbehaving caller cannot leak the resolver scope to the
-- next connection checkout.
--
-- INSERT / UPDATE / DELETE policies (tenant_isolation_insert /
-- _update / _delete) from 0001 are untouched -- their predicates
-- already pin to `id = app.tenant_id` and the resolver window must
-- not be allowed to mutate tenant rows.
--
-- Idempotency: every CREATE POLICY is preceded by DROP POLICY IF EXISTS
-- so the migration is safe to re-apply (e.g. against a tenant that
-- received a hand-patched fix between releases). The ENABLE / FORCE
-- RLS statements are no-ops if already set.

BEGIN;

-- Defensive: 0001 already enabled+forced RLS on tenants. Re-asserting
-- here is a no-op if already set; if a future migration accidentally
-- DISABLEd RLS this re-enables it.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE  ROW LEVEL SECURITY;

-- Drop the old wide-open SELECT policy. It is replaced by the two
-- narrower policies below.
DROP POLICY IF EXISTS tenant_isolation_select ON tenants;

-- Permissive policy #1: pre-tenant resolver path.
-- Gated on app.tenant_resolver = 'true'. Outside that window the GUC
-- is unset (NULL = 'true' is false), so this policy denies access.
-- The comparison is against the literal 'true' string -- defence-in-
-- depth so unrelated GUC values (e.g. a fuzzed boolean-like string)
-- don't accidentally widen the gate.
DROP POLICY IF EXISTS tenant_resolver_select ON tenants;
CREATE POLICY tenant_resolver_select ON tenants
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.tenant_resolver', true) = 'true');

-- Permissive policy #2: standard tenant-scoped read.
-- Uses the canonical NULLIF(current_setting('app.tenant_id', true), '')
-- idiom so the predicate evaluates cleanly when the GUC is unset
-- (NULLIF returns NULL, the comparison returns NULL, the policy denies
-- access -- the correct safe-default).
CREATE POLICY tenant_isolation_select ON tenants
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
