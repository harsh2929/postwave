-- 0223_merge_fields_schema.sql
--
-- Mailchimp-parity "audience field" editor. Two tables:
--
--   * merge_field_schema  — per-tenant catalog of merge tags
--                           (FNAME / LNAME / BIRTHDAY) with type +
--                           default value + required flag + display
--                           order. Operators edit this from the
--                           Subscribers page "Edit schema…" modal.
--
--   * merge_field_values  — per-(tenant, subscriber, key) value rows.
--                           Setting a value to NULL/empty deletes the
--                           row; reads fall back to the schema
--                           default. FK to schema lets a schema-row
--                           delete cascade away all its stored values.
--
-- Why a sidecar table instead of stuffing it into subscribers.merge_fields
-- (jsonb): jsonb is fine for write-time customization (we already use
-- it), but Mailchimp's UX requires per-cell history + per-cell rate
-- limits + per-cell required-validation. A row-per-(subscriber,key)
-- buys us a stable join surface for the schema-side defaults + future
-- per-cell timeline events without rewriting jsonb on every edit.

BEGIN;

CREATE TABLE merge_field_schema (
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key           text NOT NULL,
    label         text NOT NULL,
    type          text NOT NULL DEFAULT 'text',
    default_value text NOT NULL DEFAULT '',
    required      boolean NOT NULL DEFAULT false,
    position      integer NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, key),
    CHECK (type IN ('text','number','boolean','date','address','phone'))
);

CREATE INDEX merge_field_schema_tenant_position_idx
    ON merge_field_schema (tenant_id, position, created_at);

CREATE TRIGGER merge_field_schema_set_updated_at
    BEFORE UPDATE ON merge_field_schema
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON merge_field_schema TO postwave_app;

ALTER TABLE merge_field_schema ENABLE ROW LEVEL SECURITY;
ALTER TABLE merge_field_schema FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON merge_field_schema
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON merge_field_schema
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);


CREATE TABLE merge_field_values (
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    key           text NOT NULL,
    value         text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, subscriber_id, key),
    FOREIGN KEY (tenant_id, key)
        REFERENCES merge_field_schema (tenant_id, key)
        ON DELETE CASCADE
);

CREATE INDEX merge_field_values_tenant_sub_idx
    ON merge_field_values (tenant_id, subscriber_id);

CREATE TRIGGER merge_field_values_set_updated_at
    BEFORE UPDATE ON merge_field_values
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON merge_field_values TO postwave_app;

ALTER TABLE merge_field_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE merge_field_values FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON merge_field_values
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON merge_field_values
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
