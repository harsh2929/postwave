-- 0037_custom_domains.sql
--
-- Per-tenant custom domains for hosted forms, short-link redirects, and
-- public archive pages. The DNS record set we ask the operator to add is
-- frozen at create time and stored verbatim so the verify endpoint can
-- recheck the same answer Postgres handed out earlier.

BEGIN;

CREATE TABLE custom_domains (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    domain       citext NOT NULL UNIQUE,
    purpose      text NOT NULL CHECK (purpose IN ('forms', 'links', 'web')),
    verified     boolean NOT NULL DEFAULT false,
    dns_records  jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    verified_at  timestamptz
);

CREATE INDEX custom_domains_tenant_idx ON custom_domains (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON custom_domains TO postwave_app;

ALTER TABLE custom_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_domains FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON custom_domains
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
