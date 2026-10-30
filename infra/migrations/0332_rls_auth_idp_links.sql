-- 0332_rls_auth_idp_links.sql
--
-- Phase 0 hardening (p0-rls-auth-idp-links): close the long-standing
-- "no RLS on auth_idp_links" gap surfaced by the 2026 security audit
-- (docs/2026-audit/platform-optimization-sweep.md finding #27).
--
-- Background
-- ----------
-- 0058_auth_backend.sql introduced auth_idp_links as the (provider,
-- subject) -> user_id map for upstream IdP identities (Google, Microsoft,
-- SAML). The original migration intentionally left RLS DISABLED, with
-- a comment that read:
--
--     -- auth_idp_links: not tenant-scoped (cross-tenant identity links).
--     -- The user_id FK + cascade is the protection. No RLS.
--
-- That comment conflates two different guarantees:
--
--   * The FK + ON DELETE CASCADE protects against orphaned identity
--     rows -- when a user (or, via cascade, a tenant) is deleted, their
--     identity links are removed too.
--   * RLS protects against unauthorized *reads* and *writes* from the
--     `postwave_app` role at query time.
--
-- The FK does the first job. It does NOT do the second. Any code path
-- that runs `SELECT ... FROM auth_idp_links` under the postwave_app role
-- sees every (provider, subject, user_id, email, raw_claims) tuple in
-- the system -- a complete cross-tenant identity map. With the auth
-- table now backing OAuth + SAML in production multi-tenant workspaces,
-- that surface is unacceptable.
--
-- Design
-- ------
-- auth_idp_links is fundamentally *pre-tenant*: the (provider, subject)
-- pair is what we use to resolve which user (and therefore which
-- tenant) a returning OAuth/SAML subject belongs to. We cannot gate the
-- read on `app.tenant_id` because the tenant isn't known until *after*
-- the lookup succeeds.
--
-- The existing auth backend already solved this problem for the
-- companion tables (auth_credentials, auth_sessions, auth_tokens,
-- auth_totp_secrets): each has a permissive `auth_resolver` policy
-- gated on `current_setting('app.auth_resolver', true) = 'true'`,
-- which is set inside `auth.Repo.withResolverGUC()` for exactly the
-- pre-tenant resolution window. Outside that window the GUC is unset
-- and the policy returns false, leaving the table inaccessible to
-- postwave_app.
--
-- We apply the same idiom here. All current callers in
-- apps/api/internal/auth/repo.go already wrap auth_idp_links access in
-- withResolverGUC (verified for LinkIdP and LookupUserByIdP at the time
-- of this migration), so this is non-breaking.
--
-- Layered defence: we additionally add a tenant_visible policy that
-- allows access when `app.tenant_id` is set AND the user_id resolves
-- to a row whose tenant matches. This covers any future admin/UI flow
-- that needs to list a user's linked identities from within a tenant
-- context, without forcing every such flow to grab the resolver GUC.
-- The EXISTS subquery walks the users FK -- O(1) on the auth_idp_links
-- _user_idx + users PK -- so the cost is negligible.
--
-- FORCE ROW LEVEL SECURITY is on so postwave_owner (used by migrations
-- and janitors) does not bypass these policies in production. See
-- 0190_settings_hardening.sql / 0329_remaining_rls_fixup.sql /
-- 0331_force_rls_and_tenant_fk_sweep.sql for the rationale.
--
-- Idempotency: every CREATE POLICY is preceded by DROP POLICY IF EXISTS
-- so the migration is safe to re-apply (e.g. against a tenant that
-- received a hand-patched fix between releases). The ENABLE/FORCE RLS
-- statements are no-ops if already set.

BEGIN;

-- ---------------------------------------------------------------------
-- auth_idp_links: enable + force RLS
-- ---------------------------------------------------------------------
ALTER TABLE auth_idp_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_idp_links FORCE  ROW LEVEL SECURITY;

-- Permissive policy #1: pre-tenant resolver path.
-- Used by auth.Repo.LookupUserByIdP / LinkIdP, both of which run inside
-- withResolverGUC. Outside that window the GUC is unset and the policy
-- denies access (NULL = 'true' is false, not NULL, but defence-in-depth:
-- we explicitly compare to the literal 'true' string).
DROP POLICY IF EXISTS auth_resolver_all ON auth_idp_links;
CREATE POLICY auth_resolver_all ON auth_idp_links
    AS PERMISSIVE
    FOR ALL
    TO postwave_app
    USING (current_setting('app.auth_resolver', true) = 'true')
    WITH CHECK (current_setting('app.auth_resolver', true) = 'true');

-- Permissive policy #2: tenant-context path (defence-in-depth for
-- future tenant-aware UI flows like "list my linked identities").
-- Walks the user_id FK to find the owning tenant and matches against
-- the app.tenant_id GUC. Uses the canonical
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid idiom so the
-- predicate evaluates cleanly when the GUC is unset (the NULLIF returns
-- NULL, the comparison returns NULL, and the policy denies access --
-- which is the correct safe-default).
DROP POLICY IF EXISTS tenant_visible ON auth_idp_links;
CREATE POLICY tenant_visible ON auth_idp_links
    AS PERMISSIVE
    FOR ALL
    TO postwave_app
    USING (
        EXISTS (
            SELECT 1 FROM users u
             WHERE u.id = auth_idp_links.user_id
               AND u.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM users u
             WHERE u.id = auth_idp_links.user_id
               AND u.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        )
    );

COMMIT;
