-- 0027_suppressions.sql
--
-- Tenant-scoped suppression list. Adding a row here is the canonical way to
-- guarantee an address will not be sent to. Bulk import (used by CSV upload)
-- inserts in a single transaction with ON CONFLICT DO NOTHING so re-runs are
-- safe and partial imports do not surface as errors.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE suppressions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email       citext NOT NULL,
    reason      text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

CREATE INDEX suppressions_tenant_email_idx ON suppressions (tenant_id, email);

GRANT SELECT, INSERT, UPDATE, DELETE ON suppressions TO postwave_app;

ALTER TABLE suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppressions FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON suppressions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
