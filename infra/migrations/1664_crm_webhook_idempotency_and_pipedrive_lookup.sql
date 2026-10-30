-- Scope CRM webhook delivery idempotency to the owning integration and add
-- lookup support for Pipedrive webhook/OAuth route ambiguity checks.

ALTER TABLE crm_webhook_events
    DROP CONSTRAINT IF EXISTS crm_webhook_events_provider_webhook_id_key;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS crm_webhook_events_integration_delivery_unique
    ON crm_webhook_events (tenant_id, integration_id, provider, webhook_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS crm_integrations_pipedrive_webhook_lookup_idx
    ON crm_integrations (
        provider,
        (settings->>'pipedrive_webhook_id'),
        updated_at DESC
    )
    WHERE provider = 'pipedrive'
      AND status IN ('connected', 'active');

CREATE INDEX CONCURRENTLY IF NOT EXISTS crm_integrations_pipedrive_oauth_install_route_idx
    ON crm_integrations (
        provider,
        (settings->>'pipedrive_oauth_client_id'),
        (settings->>'pipedrive_company_id'),
        (settings->>'pipedrive_user_id'),
        updated_at DESC
    )
    WHERE provider = 'pipedrive'
      AND status IN ('connected', 'active', 'paused', 'error');
