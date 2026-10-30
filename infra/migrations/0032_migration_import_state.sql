-- 0032_migration_import_state.sql
--
-- Per-job import state for migration rollback and reconciliation. The public
-- migration_jobs row stores user-facing status; these tables record the exact
-- destination resources created by a commit so rollback never has to infer by
-- provider or tenant-wide source labels.

BEGIN;

CREATE TABLE IF NOT EXISTS migration_imported_resources (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    job_id                 uuid NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
    resource_type          text NOT NULL CHECK (resource_type IN (
        'subscriber',
        'segment',
        'automation',
        'campaign_archive',
        'paid_subscription'
    )),
    source_platform        text NOT NULL,
    source_id              text,
    destination_type       text NOT NULL,
    destination_id         text NOT NULL,
    destination_metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at             timestamptz NOT NULL DEFAULT now(),
    rolled_back_at         timestamptz,
    UNIQUE (tenant_id, job_id, resource_type, destination_type, destination_id)
);

CREATE INDEX IF NOT EXISTS migration_imported_resources_job_idx
    ON migration_imported_resources (tenant_id, job_id, resource_type, created_at);

CREATE INDEX IF NOT EXISTS migration_imported_resources_destination_idx
    ON migration_imported_resources (tenant_id, destination_type, destination_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON migration_imported_resources TO postwave_app;

ALTER TABLE migration_imported_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_imported_resources FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration_imported_resources;
CREATE POLICY tenant_isolation ON migration_imported_resources
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS migration_paid_subscriptions (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    job_id                   uuid NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
    source_platform          text NOT NULL,
    email                    text NOT NULL DEFAULT '',
    stripe_customer_id       text NOT NULL DEFAULT '',
    stripe_subscription_id   text NOT NULL DEFAULT '',
    stripe_price_id          text NOT NULL DEFAULT '',
    status                   text NOT NULL DEFAULT '',
    current_period_end       timestamptz,
    trial_end                timestamptz,
    source_payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    rolled_back_at           timestamptz,
    UNIQUE (tenant_id, job_id, source_platform, stripe_subscription_id, email)
);

CREATE INDEX IF NOT EXISTS migration_paid_subscriptions_job_idx
    ON migration_paid_subscriptions (tenant_id, job_id, source_platform);

CREATE INDEX IF NOT EXISTS migration_paid_subscriptions_email_idx
    ON migration_paid_subscriptions (tenant_id, lower(email))
    WHERE email <> '';

CREATE TRIGGER migration_paid_subscriptions_set_updated_at
    BEFORE UPDATE ON migration_paid_subscriptions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON migration_paid_subscriptions TO postwave_app;

ALTER TABLE migration_paid_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_paid_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration_paid_subscriptions;
CREATE POLICY tenant_isolation ON migration_paid_subscriptions
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
