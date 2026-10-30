-- 1606_ai_llm_provider_config.sql
--
-- Per-tenant BYOK (bring-your-own-key) configuration for the in-app AI
-- agent's LLM provider. The API key is stored ENCRYPTED AT REST via the
-- byok Composite cipher (EncryptForTenant), never in plaintext; one active
-- config per tenant. When a tenant has a row here, the agent's LLMFor
-- resolver uses it; otherwise the agent falls back to the platform key.
--
-- RLS uses the canonical NULLIF idiom so a missing app.tenant_id GUC
-- yields zero rows rather than crashing on a raw uuid cast.

CREATE TABLE IF NOT EXISTS ai_llm_provider_config (
    tenant_id          uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    provider           text  NOT NULL DEFAULT 'anthropic',
    model              text  NOT NULL DEFAULT '',
    -- byok Composite ciphertext (version-tagged); decrypt via DecryptForTenant.
    api_key_ciphertext bytea NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_llm_provider_config TO postwave_app;

ALTER TABLE ai_llm_provider_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_llm_provider_config FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_llm_provider_config;
CREATE POLICY tenant_isolation ON ai_llm_provider_config
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
