-- Stricter routing and idempotency for native loyalty webhooks.
-- Tokenized loyalty callbacks resolve by provider + opaque token before tenant
-- context exists, and Smile app webhooks resolve by the signed account_id. Claim
-- ledgers are scoped to the owning integration so delivery IDs cannot collide
-- across tenants or integrations.

ALTER TABLE loyalty_webhook_events
    DROP CONSTRAINT IF EXISTS loyalty_webhook_events_provider_webhook_id_key;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS loyalty_webhook_events_integration_delivery_unique
    ON loyalty_webhook_events (tenant_id, integration_id, provider, webhook_id);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS loyalty_integrations_active_ingest_token_unique
    ON loyalty_integrations ((settings->>'loyalty_ingest_token'))
    WHERE status IN ('connected', 'active', 'paused', 'error')
      AND NULLIF(settings->>'loyalty_ingest_token', '') IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS loyalty_integrations_provider_ingest_idx
    ON loyalty_integrations (provider, (settings->>'loyalty_ingest_token'))
    WHERE status IN ('connected', 'active', 'paused', 'error')
      AND NULLIF(settings->>'loyalty_ingest_token', '') IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS loyalty_integrations_smile_active_account_unique
    ON loyalty_integrations ((COALESCE(NULLIF(settings->>'account_id', ''), NULLIF(settings->>'smile_account_id', ''))))
    WHERE provider = 'smile'
      AND status IN ('connected', 'active', 'paused', 'error')
      AND COALESCE(NULLIF(settings->>'account_id', ''), NULLIF(settings->>'smile_account_id', '')) IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS loyalty_integrations_smile_account_route_idx
    ON loyalty_integrations ((COALESCE(NULLIF(settings->>'account_id', ''), NULLIF(settings->>'smile_account_id', ''))))
    WHERE provider = 'smile'
      AND status IN ('connected', 'active', 'paused', 'error')
      AND COALESCE(NULLIF(settings->>'account_id', ''), NULLIF(settings->>'smile_account_id', '')) IS NOT NULL;

DROP POLICY IF EXISTS loyalty_integrations_ingest_lookup ON loyalty_integrations;
CREATE POLICY loyalty_integrations_ingest_lookup ON loyalty_integrations
    FOR SELECT
    USING (
        status IN ('connected', 'active', 'paused', 'error')
        AND provider = NULLIF(current_setting('app.loyalty_ingest_provider', true), '')
        AND settings->>'loyalty_ingest_token' = NULLIF(current_setting('app.loyalty_ingest_token', true), '')
    );

DROP POLICY IF EXISTS loyalty_integrations_smile_webhook_lookup ON loyalty_integrations;
CREATE POLICY loyalty_integrations_smile_webhook_lookup ON loyalty_integrations
    FOR SELECT
    USING (
        provider = 'smile'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND COALESCE(NULLIF(settings->>'account_id', ''), NULLIF(settings->>'smile_account_id', '')) = NULLIF(current_setting('app.smile_account_id', true), '')
    );
