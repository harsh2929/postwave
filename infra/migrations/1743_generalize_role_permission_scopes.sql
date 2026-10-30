-- 1743_generalize_role_permission_scopes.sql
--
-- G-48 (enforcement): let a tenant role be granted GENERAL scopes, not only
-- audit:* ones. migration 0262 pinned roles_permissions.scope to the six audit
-- scopes via a CHECK, so the roles matrix could not express "may edit campaigns
-- but not billing" (write:campaigns) — the exact gap the register names. This
-- widens the CHECK to the full apikeys.Scope catalog (mirrored in
-- apps/api/internal/apikeys/apikeys.go). The application still validates scopes
-- on write; the CHECK is the DB-level backstop. Expand-only: every previously
-- valid (audit) scope stays valid, so existing rows are unaffected.

BEGIN;

ALTER TABLE public.roles_permissions
    DROP CONSTRAINT IF EXISTS roles_permissions_scope_check;

ALTER TABLE public.roles_permissions
    ADD CONSTRAINT roles_permissions_scope_check CHECK (
        scope = ANY (ARRAY[
            -- audit scopes (unchanged from 0262)
            'audit:read', 'audit:read_pii', 'audit:read_all_tenants',
            'audit:configure_sinks', 'audit:configure_retention', 'audit:execute_actions',
            -- general scopes now grantable to a role (G-48)
            'read:subscribers', 'write:subscribers',
            'read:campaigns', 'write:campaigns',
            'read:reports', 'send:transactional',
            'admin'
        ]::text[])
    );

COMMENT ON CONSTRAINT roles_permissions_scope_check ON public.roles_permissions IS
    'Allowed scopes mirror apikeys.Scope (audit + general). Update alongside the Go catalog.';

COMMIT;
