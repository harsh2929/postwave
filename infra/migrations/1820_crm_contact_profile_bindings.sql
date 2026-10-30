-- 1820_crm_contact_profile_bindings.sql
--
-- A provider contact identifier is stable when its email is not. Keep that
-- identity integration-scoped instead of claiming subscribers.external_id,
-- which is a tenant-wide canonical identifier owned by unrelated systems.
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Keep the composite parent index and binding table during
-- application rollback; older application versions do not read either.

-- PostgreSQL cannot build a concurrent index inside a transaction. This
-- redundant composite key makes the tenant relationship structurally
-- enforceable without a blocking index build on the existing integration
-- control-plane table.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS crm_integrations_tenant_id_id_provider_uniq
    ON crm_integrations (tenant_id, id, provider);

-- Lazy native adoption reads the durable migration ledger because subscriber
-- merge tombstones intentionally clear source_platform/source_id. Keep the
-- common exact-source lookup online and bounded on upgraded installations.
CREATE INDEX CONCURRENTLY IF NOT EXISTS migration_imported_resources_hubspot_subscriber_source_idx
    ON migration_imported_resources (tenant_id, source_id)
    WHERE resource_type = 'subscriber'
      AND source_platform = 'hubspot'
      AND source_id IS NOT NULL
      AND rolled_back_at IS NULL;

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS crm_contact_profile_bindings (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id        uuid NOT NULL,
    provider              text NOT NULL,
    provider_contact_id   text NOT NULL,
    subscriber_id         uuid NOT NULL,
    state                 text NOT NULL DEFAULT 'active',
    binding_origin        text NOT NULL DEFAULT 'native_email',
    last_email            citext,
    source_revision_at    timestamptz,
    state_metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at         timestamptz NOT NULL DEFAULT now(),
    last_seen_at          timestamptz NOT NULL DEFAULT now(),
    inactive_at           timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT crm_contact_profile_bindings_integration_fk
      FOREIGN KEY (tenant_id, integration_id, provider)
      REFERENCES crm_integrations (tenant_id, id, provider) ON DELETE CASCADE,
    CONSTRAINT crm_contact_profile_bindings_subscriber_fk
      FOREIGN KEY (tenant_id, subscriber_id)
      REFERENCES subscribers (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT crm_contact_profile_bindings_identity_unique
      UNIQUE (tenant_id, integration_id, provider, provider_contact_id),
    CONSTRAINT crm_contact_profile_bindings_provider_check
      CHECK (length(btrim(provider)) > 0),
    CONSTRAINT crm_contact_profile_bindings_contact_check
      CHECK (length(btrim(provider_contact_id)) > 0),
    CONSTRAINT crm_contact_profile_bindings_state_check
      CHECK (state IN ('active', 'no_email', 'deleted', 'privacy_deleted')),
    CONSTRAINT crm_contact_profile_bindings_origin_check
      CHECK (binding_origin IN ('migration_source', 'native_email'))
);

CREATE INDEX IF NOT EXISTS crm_contact_profile_bindings_subscriber_idx
    ON crm_contact_profile_bindings (tenant_id, subscriber_id, integration_id);

CREATE INDEX IF NOT EXISTS crm_contact_profile_bindings_inactive_idx
    ON crm_contact_profile_bindings (tenant_id, integration_id, state, updated_at DESC)
    WHERE state <> 'active';

DROP TRIGGER IF EXISTS crm_contact_profile_bindings_set_updated_at
    ON crm_contact_profile_bindings;
CREATE TRIGGER crm_contact_profile_bindings_set_updated_at
    BEFORE UPDATE ON crm_contact_profile_bindings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_contact_profile_bindings TO postwave_app;

ALTER TABLE crm_contact_profile_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contact_profile_bindings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON crm_contact_profile_bindings;
CREATE POLICY tenant_isolation ON crm_contact_profile_bindings
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
