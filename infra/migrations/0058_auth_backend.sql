-- 0058_auth_backend.sql
--
-- First-class auth backend. Replaces the long-standing "tenant resolved
-- from a dev header" stub with a real session model that supports:
--
--   - Email + password (argon2id)
--   - OAuth (Google, Microsoft) — per-user IdP links
--   - Magic-link sign-in
--   - Password reset
--   - Email verification
--   - TOTP MFA
--
-- Schema notes
-- ------------
--
-- * Sessions are server-side rows with cookie-carried opaque ids. The
--   cookie value is `<session_id>.<verifier>`; the DB stores HMAC of
--   the verifier (peppered) so a DB leak does not yield session
--   tokens. Revocable via UPDATE auth_sessions SET revoked_at = now().
--
-- * One-time tokens (verify, reset, magic-link) live in `auth_tokens`
--   with sha256(token) as the lookup key — never the token itself.
--
-- * `auth_idp_links` maps a user to one or more upstream IdP identities
--   (provider + subject). A single user can have password + Google +
--   Microsoft linked. The `users.auth_provider` column records the
--   *primary* method (the one used at signup).
--
-- * RLS shape: auth_credentials, auth_sessions, auth_tokens are
--   tenant-scoped under the standard tenant_isolation policy. The
--   pre-auth resolver (called BEFORE we know the tenant id) uses a
--   permissive policy gated on the `app.auth_resolver = 'true'` GUC,
--   set only inside auth.Resolver.
--
-- AWS-readiness
-- -------------
--
-- The HMAC pepper for verifier hashing comes from env
-- (POSTWAVE_AUTH_HMAC_PEPPER), which is intended to be sourced from
-- AWS Secrets Manager via the ECS task definition. Argon2id PHC
-- strings are version-prefixed so we can rotate parameters without
-- migrating data. See docs/runbooks/auth-aws.md.

BEGIN;

-- Drop the misleading NOT NULL on users.clerk_user_id — password users
-- have no upstream IdP id. UNIQUE stays; PG allows multiple NULLs.
ALTER TABLE users ALTER COLUMN clerk_user_id DROP NOT NULL;

-- Track how the user signed up + whether their email is verified.
ALTER TABLE users ADD COLUMN auth_provider text NOT NULL DEFAULT 'password'
    CHECK (auth_provider IN ('password','google','microsoft','saml','magic_link'));
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;

-- Per-tenant uniqueness on email (case-insensitive). Login resolves
-- email globally first; then if the email exists in one tenant we
-- issue the session, if multiple we return a tenant-picker.
CREATE UNIQUE INDEX users_tenant_email_idx
    ON users (tenant_id, lower(email));

-- ---------- auth_credentials ----------
-- One row per user with a password. Argon2id PHC string holds algo +
-- params + salt + hash inline so rotating params is just bcrypting
-- new logins; old hashes verify under their stored params.
CREATE TABLE auth_credentials (
    user_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    password_phc         text NOT NULL,
    password_updated_at  timestamptz NOT NULL DEFAULT now(),
    failed_attempts      int NOT NULL DEFAULT 0,
    locked_until         timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_credentials_tenant_idx ON auth_credentials (tenant_id);

-- ---------- auth_sessions ----------
-- Cookie-carried opaque session id; verifier_hash is HMAC-SHA256(verifier)
-- under POSTWAVE_AUTH_HMAC_PEPPER. last_seen_at bumps on each request.
CREATE TABLE auth_sessions (
    id              text PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    verifier_hash   bytea NOT NULL,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz,
    ip              inet,
    user_agent      text,
    mfa_satisfied   boolean NOT NULL DEFAULT false,
    auth_method     text NOT NULL CHECK (auth_method IN ('password','google','microsoft','saml','magic_link'))
);
CREATE INDEX auth_sessions_user_active_idx
    ON auth_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_expires_idx
    ON auth_sessions (expires_at) WHERE revoked_at IS NULL;

-- ---------- auth_tokens ----------
-- One-time tokens. token_hash is SHA-256(plaintext). Indexed unique
-- so the resolver can do a single lookup.
CREATE TABLE auth_tokens (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    token_hash    bytea NOT NULL UNIQUE,
    purpose       text NOT NULL CHECK (purpose IN ('email_verify','password_reset','magic_link')),
    expires_at    timestamptz NOT NULL,
    consumed_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------- auth_idp_links ----------
-- (provider, subject) is the upstream IdP identity. Cross-tenant by
-- design: a person who switches employers can re-link the same Google
-- identity to a different tenant. NOT tenant-scoped.
CREATE TABLE auth_idp_links (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider    text NOT NULL CHECK (provider IN ('google','microsoft','saml')),
    subject     text NOT NULL,
    email       citext NOT NULL,
    raw_claims  jsonb NOT NULL DEFAULT '{}'::jsonb,
    linked_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, subject)
);
CREATE INDEX auth_idp_links_user_idx ON auth_idp_links (user_id);

-- ---------- auth_totp_secrets ----------
-- Envelope-encrypted TOTP secret per user. recovery_codes_hash is an
-- array of sha256(plaintext-code); each row of bytes pops once on use.
CREATE TABLE auth_totp_secrets (
    user_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    secret_encrypted     bytea NOT NULL,
    recovery_codes_hash  bytea[] NOT NULL DEFAULT '{}'::bytea[],
    enrolled_at          timestamptz NOT NULL DEFAULT now(),
    last_used_at         timestamptz
);

-- ---------- auth_oauth_state ----------
-- Short-lived CSRF state for OAuth/SAML round-trips. Pre-auth, no
-- tenant context, tiny TTL (5–10 minutes). Janitor sweep can DELETE
-- WHERE expires_at < now() periodically.
CREATE TABLE auth_oauth_state (
    state          text PRIMARY KEY,
    provider       text NOT NULL,
    pkce_verifier  text,
    redirect_to    text,
    expires_at     timestamptz NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
    auth_credentials, auth_sessions, auth_tokens, auth_idp_links,
    auth_totp_secrets, auth_oauth_state
TO postwave_app;

-- ----------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------
-- Tenant-scoped tables: standard tenant_isolation policy.
ALTER TABLE auth_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_credentials FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON auth_credentials
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Plus a permissive resolver policy: only readable when the auth
-- middleware has set app.auth_resolver = 'true', BEFORE the tenant id
-- is known. Used during login lookup.
CREATE POLICY auth_resolver_read ON auth_credentials
    FOR SELECT
    USING (current_setting('app.auth_resolver', true) = 'true');

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON auth_sessions
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY auth_resolver_read ON auth_sessions
    FOR SELECT
    USING (current_setting('app.auth_resolver', true) = 'true');
CREATE POLICY auth_resolver_update ON auth_sessions
    FOR UPDATE
    USING (current_setting('app.auth_resolver', true) = 'true')
    WITH CHECK (current_setting('app.auth_resolver', true) = 'true');

ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON auth_tokens
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY auth_resolver_all ON auth_tokens
    FOR ALL
    USING (current_setting('app.auth_resolver', true) = 'true')
    WITH CHECK (current_setting('app.auth_resolver', true) = 'true');

ALTER TABLE auth_totp_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_totp_secrets FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON auth_totp_secrets
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY auth_resolver_read ON auth_totp_secrets
    FOR SELECT
    USING (current_setting('app.auth_resolver', true) = 'true');

-- auth_idp_links: not tenant-scoped (cross-tenant identity links).
-- The user_id FK + cascade is the protection. No RLS.

-- auth_oauth_state: pre-auth, no tenant. No RLS.

COMMIT;
