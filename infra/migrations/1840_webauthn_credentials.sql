-- 1840_webauthn_credentials.sql
--
-- AUTH-023 — WebAuthn / passkey credentials. A phishing-resistant passwordless
-- sign-in: a user enrolls a passkey in settings (registration ceremony) and
-- signs in with it (assertion ceremony). The stored public key + a monotonic
-- signature counter let the server verify each assertion.
--
-- RLS mirrors auth_credentials (migration 0058): a tenant_isolation policy for
-- enrollment/management under app.tenant_id, PLUS a permissive resolver policy
-- so the DISCOVERABLE login can read a credential by its (globally unique)
-- credential_id BEFORE any tenant/session context exists, exactly like the
-- password login's pre-tenant user lookup.
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Additive table only. No existing column/policy changes.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The owning user. ON DELETE CASCADE so removing a user clears their keys.
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Raw WebAuthn credential id (globally unique across all authenticators).
    credential_id   bytea NOT NULL UNIQUE,
    -- COSE-encoded public key used to verify assertions.
    public_key      bytea NOT NULL,
    -- Monotonic signature counter for clone detection (0 when unsupported).
    sign_count      bigint NOT NULL DEFAULT 0,
    aaguid          bytea NOT NULL DEFAULT '',
    transports      text[] NOT NULL DEFAULT '{}',
    backup_eligible boolean NOT NULL DEFAULT false,
    backup_state    boolean NOT NULL DEFAULT false,
    -- Operator-visible label ("MacBook Touch ID", "YubiKey", …).
    name            text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_used_at    timestamptz
);

CREATE INDEX IF NOT EXISTS webauthn_credentials_user_idx
    ON webauthn_credentials (tenant_id, user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON webauthn_credentials TO postwave_app;

ALTER TABLE webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE webauthn_credentials FORCE ROW LEVEL SECURITY;

-- Enrollment + management: tenant-scoped like every other tenant table.
DROP POLICY IF EXISTS tenant_isolation ON webauthn_credentials;
CREATE POLICY tenant_isolation ON webauthn_credentials
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Pre-session discoverable login: readable only when the auth middleware has
-- set app.auth_resolver = 'true' (mirrors auth_credentials.auth_resolver_read).
-- SELECT-only: the sign_count update after a successful assertion runs under
-- the resolved tenant's app.tenant_id via tenant_isolation.
DROP POLICY IF EXISTS auth_resolver_read ON webauthn_credentials;
CREATE POLICY auth_resolver_read ON webauthn_credentials
    FOR SELECT
    USING (current_setting('app.auth_resolver', true) = 'true');

COMMIT;
