-- 1571_developer_marketplace_oauth_runtime.sql
--
-- OAuth authorization-code runtime for public developer marketplace apps.
-- Raw authorization codes, access tokens, and client secrets are never stored;
-- only SHA-256 hashes are persisted.

BEGIN;

CREATE TABLE IF NOT EXISTS oauth_client_directory (
    client_id            text PRIMARY KEY,
    oauth_client_id      uuid NOT NULL,
    app_id               uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
    app_owner_tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_secret_hash   text NOT NULL,
    status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','rotated','revoked')),
    redirect_uris        text[] NOT NULL DEFAULT '{}'::text[],
    scopes               text[] NOT NULL DEFAULT '{}'::text[],
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    revoked_at           timestamptz
);

INSERT INTO oauth_client_directory (
    client_id, oauth_client_id, app_id, app_owner_tenant_id,
    client_secret_hash, status, redirect_uris, scopes, created_at, updated_at,
    revoked_at
)
SELECT client_id, id, app_id, tenant_id, client_secret_hash, status,
       redirect_uris, scopes, created_at, updated_at, revoked_at
  FROM oauth_clients
ON CONFLICT (client_id) DO UPDATE SET
    oauth_client_id = EXCLUDED.oauth_client_id,
    app_id = EXCLUDED.app_id,
    app_owner_tenant_id = EXCLUDED.app_owner_tenant_id,
    client_secret_hash = EXCLUDED.client_secret_hash,
    status = EXCLUDED.status,
    redirect_uris = EXCLUDED.redirect_uris,
    scopes = EXCLUDED.scopes,
    updated_at = EXCLUDED.updated_at,
    revoked_at = EXCLUDED.revoked_at;

CREATE INDEX IF NOT EXISTS oauth_client_directory_app_idx
    ON oauth_client_directory (app_id, status);

CREATE TABLE IF NOT EXISTS app_oauth_authorization_codes (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code_hash             text NOT NULL UNIQUE,
    client_id             text NOT NULL REFERENCES oauth_client_directory(client_id) ON DELETE CASCADE,
    app_id                uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
    app_owner_tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    installing_tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    installation_id       uuid NOT NULL REFERENCES app_installations(id) ON DELETE CASCADE,
    redirect_uri          text NOT NULL,
    scopes                text[] NOT NULL DEFAULT '{}'::text[],
    state                 text NOT NULL DEFAULT '',
    code_challenge        text NOT NULL,
    code_challenge_method text NOT NULL DEFAULT 'S256'
                          CHECK (code_challenge_method IN ('S256')),
    expires_at            timestamptz NOT NULL,
    consumed_at           timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_oauth_codes_client_idx
    ON app_oauth_authorization_codes (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS app_oauth_codes_expiry_idx
    ON app_oauth_authorization_codes (expires_at)
    WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS app_oauth_access_tokens (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash            text NOT NULL UNIQUE,
    client_id             text NOT NULL REFERENCES oauth_client_directory(client_id) ON DELETE CASCADE,
    app_id                uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
    app_owner_tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    installing_tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    installation_id       uuid NOT NULL REFERENCES app_installations(id) ON DELETE CASCADE,
    scopes                text[] NOT NULL DEFAULT '{}'::text[],
    expires_at            timestamptz NOT NULL,
    revoked_at            timestamptz,
    last_used_at          timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_oauth_tokens_installation_idx
    ON app_oauth_access_tokens (installing_tenant_id, installation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS app_oauth_tokens_expiry_idx
    ON app_oauth_access_tokens (expires_at)
    WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_client_directory TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app_oauth_authorization_codes TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app_oauth_access_tokens TO postwave_app;

COMMIT;
