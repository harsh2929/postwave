-- 0198_mailchimp_multichannel_audience_hardening.sql
--
-- Mailchimp parity hardening for multi-channel provider setup. This creates
-- tenant-scoped OAuth/credential storage for social publishing and ad
-- providers. The API stores credentials only in credential_envelope; metadata
-- may contain fingerprints and account labels, never plaintext tokens.

BEGIN;

CREATE TABLE IF NOT EXISTS social_provider_connections (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider            text NOT NULL CHECK (provider IN (
        'meta_pages', 'meta_instagram', 'meta_ads', 'google_ads'
    )),
    account_id          text,
    status              text NOT NULL DEFAULT 'connected' CHECK (status IN (
        'connected', 'validated', 'needs_credentials', 'disabled', 'expired'
    )),
    scopes              jsonb NOT NULL DEFAULT '[]'::jsonb,
    credential_envelope bytea,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
    token_expires_at    timestamptz,
    last_validated_at   timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, provider, account_id)
);

CREATE INDEX IF NOT EXISTS social_provider_connections_tenant_idx
    ON social_provider_connections (tenant_id, provider, status);

CREATE INDEX IF NOT EXISTS social_provider_connections_validated_idx
    ON social_provider_connections (tenant_id, provider, last_validated_at DESC)
    WHERE status IN ('connected', 'validated');

DROP TRIGGER IF EXISTS social_provider_connections_set_updated_at
    ON social_provider_connections;
CREATE TRIGGER social_provider_connections_set_updated_at
    BEFORE UPDATE ON social_provider_connections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON social_provider_connections TO postwave_app;

ALTER TABLE social_provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_provider_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON social_provider_connections;
CREATE POLICY tenant_isolation ON social_provider_connections
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
