-- 1846_transactional_provider_message_lookup.sql
--
-- SES feedback attribution resolves a successful public transactional send by
-- provider_message_id. Keep this lookup selective without declaring provider
-- IDs globally unique: historical/provider collisions must remain observable
-- so the resolver can fail closed on more than one tenant owner.
--
-- rollback-strategy: no-op - the index is additive and safe to retain if the application rolls back.
-- rollback-details: DROP INDEX CONCURRENTLY IF EXISTS transactional_emails_provider_message_lookup_idx only if measured write amplification requires it; feedback lookups then fall back to a tenant-ledger scan.

CREATE INDEX CONCURRENTLY IF NOT EXISTS transactional_emails_provider_message_lookup_idx
    ON transactional_emails (provider_message_id, tenant_id)
    WHERE provider_message_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_events_provider_message_lookup_idx
    ON outbox_events ((payload->>'esp_message_id'), tenant_id)
    WHERE NULLIF(payload->>'esp_message_id', '') IS NOT NULL;
