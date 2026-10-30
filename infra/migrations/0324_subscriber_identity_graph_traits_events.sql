-- 0324_subscriber_identity_graph_traits_events.sql
--
-- Subscribers 2026 long-tail tranche:
--   * SUB-002: persistent identity graph / profile_aliases
--   * SUB-007: computed traits / materialized attributes
--   * SUB-114: custom subscriber event ingestion
--   * SUB-131: lifecycle-stage transition evidence

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS profile_aliases (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id   uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    alias_type      text NOT NULL CHECK (alias_type IN (
        'email', 'external_id', 'anonymous_id', 'phone',
        'device_token', 'push_token', 'custom'
    )),
    alias_value     text NOT NULL,
    confidence      numeric(4,3) NOT NULL DEFAULT 1.000
                    CHECK (confidence >= 0 AND confidence <= 1),
    source          text NOT NULL DEFAULT 'api',
    provenance      jsonb NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS profile_aliases_unique_value_idx
    ON profile_aliases (tenant_id, alias_type, lower(alias_value));

CREATE INDEX IF NOT EXISTS profile_aliases_subscriber_idx
    ON profile_aliases (tenant_id, subscriber_id, alias_type);

CREATE TRIGGER profile_aliases_set_updated_at
    BEFORE UPDATE ON profile_aliases
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON profile_aliases TO postwave_app;

ALTER TABLE profile_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_aliases FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON profile_aliases
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON profile_aliases
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS subscriber_computed_traits (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id   uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    key             text NOT NULL CHECK (key ~ '^[a-zA-Z0-9_.:-]{1,96}$'),
    value           jsonb NOT NULL DEFAULT 'null'::jsonb,
    value_type      text NOT NULL DEFAULT 'json'
                    CHECK (value_type IN ('string','number','boolean','date','datetime','json')),
    source          text NOT NULL DEFAULT 'operator'
                    CHECK (source IN ('operator','api','model','warehouse','system')),
    model_version   text,
    confidence      numeric(4,3)
                    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    drivers         jsonb NOT NULL DEFAULT '[]'::jsonb,
    computed_at     timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, subscriber_id, key)
);

CREATE INDEX IF NOT EXISTS subscriber_computed_traits_key_idx
    ON subscriber_computed_traits (tenant_id, key, updated_at DESC);

CREATE INDEX IF NOT EXISTS subscriber_computed_traits_subscriber_idx
    ON subscriber_computed_traits (tenant_id, subscriber_id, key);

CREATE TRIGGER subscriber_computed_traits_set_updated_at
    BEFORE UPDATE ON subscriber_computed_traits
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_computed_traits TO postwave_app;

ALTER TABLE subscriber_computed_traits ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_computed_traits FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriber_computed_traits
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscriber_computed_traits
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS subscriber_lifecycle_events (
    id             bigserial PRIMARY KEY,
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id  uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    previous_stage text,
    next_stage     text NOT NULL,
    score          smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
    source         text NOT NULL DEFAULT 'operator',
    reason         text NOT NULL DEFAULT '',
    at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriber_lifecycle_events_subscriber_idx
    ON subscriber_lifecycle_events (tenant_id, subscriber_id, at DESC);

CREATE INDEX IF NOT EXISTS subscriber_lifecycle_events_stage_idx
    ON subscriber_lifecycle_events (tenant_id, next_stage, at DESC);

GRANT SELECT, INSERT ON subscriber_lifecycle_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE subscriber_lifecycle_events_id_seq TO postwave_app;

ALTER TABLE subscriber_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_lifecycle_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriber_lifecycle_events
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscriber_lifecycle_events
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE subscriber_events
    DROP CONSTRAINT IF EXISTS subscriber_events_event_type_check;

ALTER TABLE subscriber_events
    ADD CONSTRAINT subscriber_events_event_type_check
    CHECK (event_type IN (
        'opened','clicked','bounced','complained','unsubscribed','replied',
        'custom','identified','merged','suppressed','status_changed',
        'consent_changed','lifecycle_stage_changed'
    ));

COMMIT;
