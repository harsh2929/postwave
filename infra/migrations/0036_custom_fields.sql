-- 0036_custom_fields.sql
--
-- Per-tenant registry of "custom fields" — schema metadata describing
-- what tenant-specific subscriber attributes a workspace has defined.
-- subscribers.custom_fields (jsonb) already stores the values; this
-- table is the discoverable schema layer on top so admins + the API
-- can list known fields, type-check at write time, and surface a UI
-- field-builder.
--
-- Closes the OpenAPI ghost-route audit finding: POST /api/v1/custom-fields
-- exists in the spec + sdk-ts, but the gateway had no handler. After
-- this migration + the apps/api/internal/customfields handler, the SDK
-- method works end-to-end.

BEGIN;

CREATE TABLE tenant_custom_fields (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key         text        NOT NULL,                 -- machine name, e.g. "loyalty_tier"
    label       text        NOT NULL,                 -- display name
    type        text        NOT NULL                  -- value type at the JSON level
                CHECK (type IN ('string', 'number', 'boolean', 'date')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- (tenant_id, key) is the natural unique constraint — keys must be
-- distinct per tenant. Lookup by key is a hot path (write-time type check).
CREATE UNIQUE INDEX tenant_custom_fields_tenant_key_idx
    ON tenant_custom_fields (tenant_id, key);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_custom_fields TO postwave_app;

ALTER TABLE tenant_custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_custom_fields FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_custom_fields
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
