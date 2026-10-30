-- 0122_scim_provisioning.sql
--
-- SCIM 2.0 provisioning (RFC 7642/7643/7644). Lets an IdP (Okta, Entra,
-- OneLogin, JumpCloud, Google Workspace via SAML Jit, etc.) lifecycle-
-- manage Postwave users + groups via a stable HTTP contract:
--
--   GET    /scim/v2/Users           — list
--   POST   /scim/v2/Users           — provision
--   GET    /scim/v2/Users/{id}      — read
--   PUT    /scim/v2/Users/{id}      — full replace
--   PATCH  /scim/v2/Users/{id}      — partial update
--   DELETE /scim/v2/Users/{id}      — deactivate
--   (same pattern for Groups)
--
-- Auth: per-tenant SCIM bearer token (stored hashed in
-- scim_tokens). The IdP sends `Authorization: Bearer <token>` and we
-- resolve to a tenant_id. No tenant_id in the URL — every IdP
-- expects a single tenant-scoped endpoint.
--
-- Group-to-role mapping: scim_role_mappings lets the operator say
-- "group=admins → role=admin", "group=editors → role=editor". JIT
-- provisioning resolves the SCIM group set into a Postwave role.

BEGIN;

-- Extend users with the lifecycle column SCIM needs. SCIM PATCH
-- active=false flips status to 'suspended'; SCIM DELETE does the
-- same. Existing rows default to 'active'.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','suspended','deleted'));

-- One bearer token per tenant. We store sha256 of the token so a
-- leaked DB dump doesn't expose live tokens. Token shown ONCE at
-- creation time.
CREATE TABLE IF NOT EXISTS scim_tokens (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    token_sha256    bytea NOT NULL UNIQUE,
    token_prefix    text NOT NULL,  -- first 8 chars for dashboard display
    description     text NOT NULL DEFAULT '',
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz,
    last_used_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_scim_tokens_tenant
    ON scim_tokens (tenant_id, revoked_at);

GRANT SELECT, INSERT, UPDATE ON scim_tokens TO postwave_app;

ALTER TABLE scim_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON scim_tokens AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- SCIM token bearer needs a worker-permissive lookup path so the
-- SCIM handler can resolve token → tenant without a tenant context.
CREATE POLICY scim_tokens_worker_select ON scim_tokens
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

-- SCIM Users: one row per IdP-provisioned external identity. Mirrors
-- core fields but does NOT replace the existing users table — Postwave
-- users join to scim_users on (tenant_id, external_id) when SSO is
-- configured.
CREATE TABLE IF NOT EXISTS scim_users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    external_id     text NOT NULL,  -- IdP-stable id (Okta userId, Entra OID)
    user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
    user_name       text NOT NULL,  -- typically email
    display_name    text,
    given_name      text,
    family_name     text,
    active          boolean NOT NULL DEFAULT true,
    email_primary   text,
    raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, external_id),
    UNIQUE (tenant_id, user_name)
);

CREATE INDEX IF NOT EXISTS idx_scim_users_tenant
    ON scim_users (tenant_id, active);

GRANT SELECT, INSERT, UPDATE, DELETE ON scim_users TO postwave_app;

ALTER TABLE scim_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON scim_users AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- SCIM Groups: tenant-scoped collection of scim_users. The set of
-- group names a user belongs to feeds into scim_role_mappings to
-- pick the user's Postwave role.
CREATE TABLE IF NOT EXISTS scim_groups (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    external_id     text NOT NULL,
    display_name    text NOT NULL,
    raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, external_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON scim_groups TO postwave_app;

ALTER TABLE scim_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON scim_groups AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE TABLE IF NOT EXISTS scim_group_members (
    tenant_id       uuid NOT NULL,
    group_id        uuid NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,
    scim_user_id    uuid NOT NULL REFERENCES scim_users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, scim_user_id)
);

GRANT SELECT, INSERT, DELETE ON scim_group_members TO postwave_app;

ALTER TABLE scim_group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON scim_group_members AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- scim_role_mappings: ordered group-name → Postwave-role rules.
-- JIT provisioning iterates by `precedence` ascending and picks the
-- first match. A wildcard fallback (group_name = '*') can pin a
-- default role. Operator-defined per tenant.
CREATE TABLE IF NOT EXISTS scim_role_mappings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    group_name      text NOT NULL,  -- IdP group displayName, or '*'
    role            text NOT NULL CHECK (role IN ('owner','admin','editor','viewer')),
    precedence      int NOT NULL DEFAULT 100,  -- lower = checked first
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, group_name)
);

CREATE INDEX IF NOT EXISTS idx_scim_role_mappings_lookup
    ON scim_role_mappings (tenant_id, precedence);

GRANT SELECT, INSERT, UPDATE, DELETE ON scim_role_mappings TO postwave_app;

ALTER TABLE scim_role_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON scim_role_mappings AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
