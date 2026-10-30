-- Pipedrive CRM OAuth install state and encrypted credential storage.

CREATE TABLE IF NOT EXISTS crm_oauth_states (
    state_hash       text PRIMARY KEY,
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider         text NOT NULL,
    integration_name text NOT NULL DEFAULT '',
    redirect_uri     text NOT NULL DEFAULT '',
    redirect_to      text,
    scopes           text[] NOT NULL DEFAULT '{}',
    settings         jsonb NOT NULL DEFAULT '{}',
    expires_at       timestamptz NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_oauth_states_tenant_provider_idx
    ON crm_oauth_states (tenant_id, provider, created_at DESC);

CREATE INDEX IF NOT EXISTS crm_oauth_states_expiry_idx
    ON crm_oauth_states (expires_at);

GRANT SELECT, INSERT, DELETE ON crm_oauth_states TO postwave_app;

-- OAuth callback consumption is pre-authenticated by the high-entropy state
-- token; store only its SHA-256 hash and keep the table outside tenant RLS,
-- matching the short-lived auth_oauth_state pattern.

CREATE TABLE IF NOT EXISTS crm_credential_secrets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider        text NOT NULL,
    ref             text NOT NULL,
    secret_envelope bytea NOT NULL,
    metadata        jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, provider, ref)
);

CREATE INDEX IF NOT EXISTS crm_credential_secrets_tenant_provider_idx
    ON crm_credential_secrets (tenant_id, provider, updated_at DESC);

DROP TRIGGER IF EXISTS crm_credential_secrets_set_updated_at ON crm_credential_secrets;
CREATE TRIGGER crm_credential_secrets_set_updated_at
    BEFORE UPDATE ON crm_credential_secrets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_credential_secrets TO postwave_app;

ALTER TABLE crm_credential_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_credential_secrets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON crm_credential_secrets;
CREATE POLICY tenant_isolation ON crm_credential_secrets
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
