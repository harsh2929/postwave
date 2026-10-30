-- 0018_api_keys.sql
--
-- Personal-access-token style API keys for the public REST API. Keys are
-- stored hashed only — the plaintext is shown once at creation time and
-- never recoverable. The visible "prefix" (e.g. pw_live_4tA7) is kept in
-- plaintext so the admin UI can render `pw_live_••••3a2b` shorthand.

BEGIN;

CREATE TABLE api_keys (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    label         text NOT NULL,
    prefix        text NOT NULL,        -- e.g. "pw_live_4tA7"
    key_hash      text NOT NULL,        -- sha256 hex of the full plaintext
    scopes        text[] NOT NULL DEFAULT '{}',
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz,
    revoked_at    timestamptz
);

CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id);
CREATE UNIQUE INDEX api_keys_hash_idx ON api_keys (key_hash);

GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO postwave_app;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON api_keys
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Public middleware lookup for a single hashed key. The repository binds the
-- hash into app.api_key_hash for the transaction; successful lookup derives
-- the tenant for downstream db.WithTenant queries.
CREATE POLICY api_keys_hash_lookup ON api_keys
    FOR SELECT
    USING (
        revoked_at IS NULL
        AND key_hash = NULLIF(current_setting('app.api_key_hash', true), '')
    );

-- Best-effort middleware touch for the key that was just authenticated.
CREATE POLICY api_keys_last_used_public_update ON api_keys
    FOR UPDATE
    USING (
        revoked_at IS NULL
        AND id = NULLIF(current_setting('app.api_key_id', true), '')::uuid
    )
    WITH CHECK (
        revoked_at IS NULL
        AND id = NULLIF(current_setting('app.api_key_id', true), '')::uuid
    );

COMMIT;
