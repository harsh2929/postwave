-- 0201_klaviyo_profile_predicate_registry.sql
--
-- Klaviyo parity slice KLV-06: make segmentation/CDP activation discoverable
-- through a tenant-scoped predicate and metric registry, plus the durable
-- custom-object and segment-snapshot foundations those predicates will target.

BEGIN;

-- segments was created with only a restrictive policy. Add the permissive
-- companion so tenant-scoped API calls can read/write saved segments under
-- FORCE RLS.
DROP POLICY IF EXISTS tenant_visible ON segments;
CREATE POLICY tenant_visible ON segments
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE predicate_registry (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key             text NOT NULL,
    label           text NOT NULL,
    category        text NOT NULL
                    CHECK (category IN ('profile','engagement','consent','custom_field','event','metric','custom_object','commerce','system')),
    value_type      text NOT NULL
                    CHECK (value_type IN ('string','number','boolean','date','datetime','enum','json','object','array')),
    comparators     text[] NOT NULL DEFAULT '{}',
    source          text NOT NULL DEFAULT 'system'
                    CHECK (source IN ('system','subscriber','custom_field','track','commerce','metric','custom_object','migration')),
    source_ref      text NOT NULL DEFAULT '',
    activation      text[] NOT NULL DEFAULT '{segment,flow,report}',
    compiler_status text NOT NULL DEFAULT 'supported'
                    CHECK (compiler_status IN ('supported','partial','planned','unsupported')),
    definition      jsonb NOT NULL DEFAULT '{}',
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','deprecated','disabled')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
);

CREATE INDEX predicate_registry_tenant_category_idx
    ON predicate_registry (tenant_id, category, status, key);

CREATE TRIGGER predicate_registry_set_updated_at
    BEFORE UPDATE ON predicate_registry
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON predicate_registry TO postwave_app;

ALTER TABLE predicate_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE predicate_registry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON predicate_registry
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON predicate_registry
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE metric_definitions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key              text NOT NULL,
    label            text NOT NULL,
    source           text NOT NULL DEFAULT 'track'
                     CHECK (source IN ('subscriber_events','track','commerce','system','custom_object','computed')),
    event_name       text NOT NULL DEFAULT '',
    aggregation      text NOT NULL DEFAULT 'count'
                     CHECK (aggregation IN ('count','sum','avg','min','max','last','exists')),
    property_path    text NOT NULL DEFAULT '',
    value_type       text NOT NULL DEFAULT 'number'
                     CHECK (value_type IN ('number','string','boolean','date','datetime','json')),
    lookback_days    integer,
    definition       jsonb NOT NULL DEFAULT '{}',
    status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','deprecated','disabled')),
    first_seen_at    timestamptz,
    last_seen_at     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
);

CREATE INDEX metric_definitions_tenant_source_idx
    ON metric_definitions (tenant_id, source, status, key);

CREATE TRIGGER metric_definitions_set_updated_at
    BEFORE UPDATE ON metric_definitions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON metric_definitions TO postwave_app;

ALTER TABLE metric_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON metric_definitions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON metric_definitions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE segment_snapshots (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    segment_id          uuid REFERENCES segments(id) ON DELETE CASCADE,
    query_ast           jsonb NOT NULL DEFAULT '{}',
    count               integer NOT NULL DEFAULT 0,
    sample_subscribers  jsonb NOT NULL DEFAULT '[]',
    evaluator_version   text NOT NULL DEFAULT 'segments.v1',
    evaluated_at        timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX segment_snapshots_tenant_segment_idx
    ON segment_snapshots (tenant_id, segment_id, evaluated_at DESC);

GRANT SELECT, INSERT, DELETE ON segment_snapshots TO postwave_app;

ALTER TABLE segment_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE segment_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON segment_snapshots
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON segment_snapshots
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE custom_object_types (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key             text NOT NULL,
    label           text NOT NULL,
    primary_key     text NOT NULL DEFAULT 'external_id',
    schema          jsonb NOT NULL DEFAULT '{}',
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','deprecated','disabled')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
);

CREATE TRIGGER custom_object_types_set_updated_at
    BEFORE UPDATE ON custom_object_types
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON custom_object_types TO postwave_app;

ALTER TABLE custom_object_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_object_types FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON custom_object_types
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON custom_object_types
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE custom_object_records (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    object_type_id  uuid NOT NULL REFERENCES custom_object_types(id) ON DELETE CASCADE,
    external_id     text NOT NULL,
    properties      jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, object_type_id, external_id)
);

CREATE INDEX custom_object_records_tenant_type_idx
    ON custom_object_records (tenant_id, object_type_id, updated_at DESC);

CREATE TRIGGER custom_object_records_set_updated_at
    BEFORE UPDATE ON custom_object_records
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON custom_object_records TO postwave_app;

ALTER TABLE custom_object_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_object_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON custom_object_records
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON custom_object_records
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE profile_object_links (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    object_type_id    uuid NOT NULL REFERENCES custom_object_types(id) ON DELETE CASCADE,
    object_record_id  uuid NOT NULL REFERENCES custom_object_records(id) ON DELETE CASCADE,
    subscriber_id     uuid,
    subscriber_email  text NOT NULL DEFAULT '',
    relationship      text NOT NULL DEFAULT 'related',
    metadata          jsonb NOT NULL DEFAULT '{}',
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, object_record_id, subscriber_id, subscriber_email, relationship)
);

CREATE INDEX profile_object_links_profile_idx
    ON profile_object_links (tenant_id, subscriber_id, lower(subscriber_email));

GRANT SELECT, INSERT, UPDATE, DELETE ON profile_object_links TO postwave_app;

ALTER TABLE profile_object_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_object_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON profile_object_links
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON profile_object_links
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE profile_property_transform_rules (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            text NOT NULL,
    source_path     text NOT NULL,
    target_key      text NOT NULL,
    transform       text NOT NULL DEFAULT 'copy'
                    CHECK (transform IN ('copy','lowercase','uppercase','trim','date','number','boolean','json_path')),
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','paused','archived')),
    definition      jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE TRIGGER profile_property_transform_rules_set_updated_at
    BEFORE UPDATE ON profile_property_transform_rules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON profile_property_transform_rules TO postwave_app;

ALTER TABLE profile_property_transform_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_property_transform_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON profile_property_transform_rules
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON profile_property_transform_rules
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
