-- 0003_subscribers.sql
--
-- Postwave-side mirror of Listmonk's subscribers concept, scoped per tenant.
-- We keep our own canonical copy so we can:
--   * enforce multi-tenant isolation at the row level (Listmonk is single-
--     tenant per install),
--   * store provenance fields (source_id / source_platform) for migration
--     reconciliation against the upstream platform, and
--   * remain decoupled from Listmonk's internal schema (HTTP boundary —
--     see LICENSE-BOUNDARY.md).

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE subscribers (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email               citext NOT NULL,
    status              text NOT NULL CHECK (status IN ('enabled', 'disabled', 'blocklisted', 'unconfirmed')),
    consent_timestamp   timestamptz,
    consent_source      text NOT NULL CHECK (consent_source IN ('double_optin', 'single_optin', 'import', 'api', 'unknown')),
    custom_fields       jsonb NOT NULL DEFAULT '{}'::jsonb,
    tags                text[] NOT NULL DEFAULT '{}'::text[],
    source_id           text,
    source_platform     text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

CREATE INDEX subscribers_tenant_status_idx ON subscribers (tenant_id, status);
CREATE INDEX subscribers_tenant_email_idx  ON subscribers (tenant_id, email);
CREATE INDEX subscribers_tags_gin          ON subscribers USING GIN (tags);
CREATE INDEX subscribers_custom_fields_gin ON subscribers USING GIN (custom_fields);

CREATE TRIGGER subscribers_set_updated_at
    BEFORE UPDATE ON subscribers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON subscribers TO postwave_app;

-- RLS: every query MUST be inside a tx with `SET LOCAL app.tenant_id = ...`.
ALTER TABLE subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscribers FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscribers
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
