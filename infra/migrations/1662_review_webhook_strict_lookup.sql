-- Stricter routing for native review webhooks.
-- Public review callbacks resolve a row before tenant context exists, so the
-- RLS lookup policy must bind both provider path and opaque token. Ambiguous
-- active tokens are rejected by the application lookup and prevented for new
-- active rows by the unique index below. Webhook delivery claims are scoped to
-- the owning integration so the same provider delivery id cannot collide across
-- tenants/integrations, while same-integration replays can still be deduped.

ALTER TABLE review_webhook_events
    DROP CONSTRAINT IF EXISTS review_webhook_events_provider_webhook_id_key;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS review_webhook_events_integration_delivery_unique
    ON review_webhook_events (tenant_id, integration_id, provider, webhook_id);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS review_integrations_active_ingest_token_unique
    ON review_integrations ((settings->>'review_ingest_token'))
    WHERE status IN ('connected', 'active', 'paused', 'error')
      AND NULLIF(settings->>'review_ingest_token', '') IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS review_integrations_provider_ingest_idx
    ON review_integrations (provider, (settings->>'review_ingest_token'))
    WHERE status IN ('connected', 'active', 'paused', 'error')
      AND NULLIF(settings->>'review_ingest_token', '') IS NOT NULL;

DROP POLICY IF EXISTS review_integrations_ingest_lookup ON review_integrations;
CREATE POLICY review_integrations_ingest_lookup ON review_integrations
    FOR SELECT
    USING (
        status IN ('connected', 'active', 'paused', 'error')
        AND provider = NULLIF(current_setting('app.review_ingest_provider', true), '')
        AND settings->>'review_ingest_token' = NULLIF(current_setting('app.review_ingest_token', true), '')
    );
