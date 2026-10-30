-- 0010_voice.sql
--
-- Pillar 3 (Voice) persistence. Replaces the in-memory MemoryStore in
-- services/voice/internal/handlers with durable, RLS-isolated tables:
--
--   voice_sources    one row per registered ingestion endpoint per tenant
--   voice_items      ingested raw text per source (used for profile builds)
--   voice_profiles   built VoiceProfile JSON, one per tenant
--   voice_sequences  generated email sequences (Sequence JSON)
--   voice_templates  seeded starter library + admin-authored templates

BEGIN;

-- ---------------------------------------------------------------------------
-- voice_sources
-- ---------------------------------------------------------------------------
CREATE TABLE voice_sources (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    type              text NOT NULL,                                -- e.g. 'rss', 'twitter', 'paste_in'
    params            jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_ingested_at  timestamptz,
    item_count        int NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX voice_sources_tenant_type_idx ON voice_sources (tenant_id, type);

GRANT SELECT, INSERT, UPDATE, DELETE ON voice_sources TO postwave_app;

ALTER TABLE voice_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_sources FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON voice_sources
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- voice_items
-- ---------------------------------------------------------------------------
CREATE TABLE voice_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source_id       uuid REFERENCES voice_sources(id) ON DELETE CASCADE,
    source_type     text,
    text            text NOT NULL,
    published_at    timestamptz,
    url             text,
    title           text,
    tokens          int,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX voice_items_tenant_pub_idx
    ON voice_items (tenant_id, source_type, published_at DESC NULLS LAST);
CREATE INDEX voice_items_source_idx ON voice_items (source_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON voice_items TO postwave_app;

ALTER TABLE voice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_items FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON voice_items
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- voice_profiles
-- ---------------------------------------------------------------------------
CREATE TABLE voice_profiles (
    tenant_id              uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    profile                jsonb NOT NULL,
    built_at               timestamptz,
    representative_samples jsonb,
    updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER voice_profiles_set_updated_at
    BEFORE UPDATE ON voice_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON voice_profiles TO postwave_app;

ALTER TABLE voice_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_profiles FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON voice_profiles
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- voice_sequences
-- ---------------------------------------------------------------------------
CREATE TABLE voice_sequences (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    template_id     text,
    name            text NOT NULL,
    status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
    emails          jsonb NOT NULL,
    style_controls  jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX voice_sequences_tenant_status_idx
    ON voice_sequences (tenant_id, status, updated_at DESC);

CREATE TRIGGER voice_sequences_set_updated_at
    BEFORE UPDATE ON voice_sequences
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON voice_sequences TO postwave_app;

ALTER TABLE voice_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_sequences FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON voice_sequences
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- voice_templates (admin-authored library)
-- ---------------------------------------------------------------------------
-- Shared template library. services/voice seeds the embedded starter library
-- into this table on startup, and admin-authored templates are stored here.
CREATE TABLE voice_templates (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text UNIQUE NOT NULL,
    category    text NOT NULL,
    name        text NOT NULL,
    description text,
    length      int NOT NULL,
    variables   jsonb NOT NULL DEFAULT '[]'::jsonb,
    emails      jsonb NOT NULL,
    tags        text[],
    author      text,
    performance jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX voice_templates_category_idx ON voice_templates (category);

CREATE TRIGGER voice_templates_set_updated_at
    BEFORE UPDATE ON voice_templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Templates are platform-level (shared across tenants). No RLS — admin role
-- gate at the API layer.
GRANT SELECT ON voice_templates TO postwave_app;
GRANT INSERT, UPDATE, DELETE ON voice_templates TO postwave_app;

COMMIT;
