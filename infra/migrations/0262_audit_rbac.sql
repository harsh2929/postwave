-- 0262_audit_rbac.sql
--
-- RBAC on audit read endpoints + meta-audit trail. Two new tables:
--
-- 1. roles                — tenant-defined named roles (audit_viewer,
--                            audit_admin, …). Tenants can rename or
--                            add their own; we ship two seed names.
-- 2. roles_permissions    — join table mapping (role_id) -> scope.
--                            scope is a text enum-like field whose
--                            allowed values are mirrored in the Go
--                            apikeys.AllAuditScopes catalog.
--
-- The audit_log already carries the action label for the meta-audit
-- trail (`audit.read.list`, `audit.read.export`, …) — no schema
-- change required, only new well-known action values written by the
-- AuditMetaMiddleware in apps/api/internal/middleware/audit_meta.go.
--
-- Compliance gap-doc category: Compliance, priority P0.

BEGIN;

-- roles: one row per (tenant_id, name). Tenants can rename or add
-- their own; we seed audit_viewer + audit_admin per tenant in a
-- separate tenant-creation hook (not in this migration so we
-- can ship the schema independently of the seed-data backfill).
CREATE TABLE IF NOT EXISTS roles (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    name          text NOT NULL,
    description   text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_roles_tenant
    ON roles (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON roles TO postwave_app;

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON roles AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The audit-admin worker (separate sweep) can read every tenant's
-- roles to build cross-tenant compliance dashboards. Gated on the
-- worker GUC so admin-tier endpoints don't accidentally inherit it.
CREATE POLICY roles_audit_worker_select ON roles
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (current_setting('app.audit_admin_worker', true) = 'true');

-- roles_permissions: join table mapping (role_id) -> scope. Each row
-- grants one scope to one role. scope is a text field whose allowed
-- values are mirrored in apps/api/internal/apikeys/apikeys.go
-- (AllAuditScopes) and enforced via the CHECK below + the
-- IsAuditScope helper on the Go side.
CREATE TABLE IF NOT EXISTS roles_permissions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id     uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    scope       text NOT NULL CHECK (scope IN (
        'audit:read',
        'audit:read_pii',
        'audit:read_all_tenants',
        'audit:configure_sinks',
        'audit:configure_retention',
        'audit:execute_actions'
    )),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (role_id, scope)
);

CREATE INDEX IF NOT EXISTS idx_roles_permissions_role
    ON roles_permissions (role_id);

GRANT SELECT, INSERT, DELETE ON roles_permissions TO postwave_app;

-- RLS on roles_permissions defers to the parent role's tenant
-- visibility — we walk the join to roles.tenant_id rather than
-- duplicating the column so a role-rename can't desync.
ALTER TABLE roles_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON roles_permissions AS PERMISSIVE FOR ALL TO postwave_app
    USING (EXISTS (
        SELECT 1 FROM roles r
         WHERE r.id = roles_permissions.role_id
           AND r.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM roles r
         WHERE r.id = roles_permissions.role_id
           AND r.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    ));

CREATE POLICY roles_permissions_audit_worker_select ON roles_permissions
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (current_setting('app.audit_admin_worker', true) = 'true');

-- Audit-trail note: audit.read.* events written by the
-- AuditMetaMiddleware are first-class audit_log rows. They obey the
-- standard retention policy and the Merkle hash-chain; they are NOT
-- redacted regardless of the caller's scope set. The frontend filter
-- "Show audit-read events" simply toggles an ILIKE on action.
--
-- audit.rbac.role_updated is written by UpdateRoleScopes
-- (apps/api/internal/handlers/audit_rbac.go) inside the same tx as
-- the roles_permissions rewrite so the row set + the audit row
-- commit atomically.

COMMIT;
