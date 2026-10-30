-- Shared, immutable engine identity for app reads/sending and migration writes.
-- Credentials remain in the deployment secret store. Application roles can
-- create and read a binding but cannot retarget or delete one.
BEGIN;
CREATE TABLE tenant_email_destinations (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    destination_id uuid NOT NULL UNIQUE,
    endpoint_hash text NOT NULL UNIQUE CHECK (endpoint_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant_email_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_email_destinations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_email_destinations_tenant ON tenant_email_destinations
    FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON tenant_email_destinations TO postwave_app;
COMMIT;
