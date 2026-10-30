-- 0261_brand_voice_profiles.sql
--
-- G10 (campaigns 2026): operator-authored brand voice profile.
--
-- Postwave's VoiceDriftBanner is advisory and reads only the
-- auto-extracted voice_profiles JSON. Operators can't author the
-- brand voice (descriptors, writing rules, sample snippets), so the
-- drift output is unreliable for tenants with sparse corpora and
-- there's no Rewrite affordance.
--
-- This table holds an operator-authored profile per tenant. The
-- compose endpoints (G10 follow-up) will condition AI output on the
-- active row; the drift scorer (G10 follow-up) will compare against
-- it; the desktop Voice tab edits it directly.
--
-- One active profile per tenant: enforced by the partial unique
-- index on (tenant_id) WHERE is_active. Inactive rows are kept for
-- versioning / audit. Deactivating + activating in one transaction
-- swaps the active row atomically.

BEGIN;

CREATE TABLE IF NOT EXISTS brand_voice_profiles (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Descriptive chips ("warm", "no-jargon", "second-person")
    descriptors     text[]      NOT NULL DEFAULT '{}',
    -- Hard rules ("never use exclamation marks", "always use serial commas")
    writing_rules   text[]      NOT NULL DEFAULT '{}',
    -- 1-10 sample paragraphs from the tenant's existing content.
    -- Stored as text[] (not jsonb) so the upstream LLM can read them
    -- inline without parsing.
    sample_snippets text[]      NOT NULL DEFAULT '{}',
    is_active       boolean     NOT NULL DEFAULT true,
    -- extracted_at non-null when the row was seeded by
    -- /voice/brand-profile/extract (G10 follow-up); null on
    -- operator-authored profiles.
    extracted_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS brand_voice_profiles_active_uq
    ON brand_voice_profiles (tenant_id)
    WHERE is_active;

GRANT SELECT, INSERT, UPDATE, DELETE ON brand_voice_profiles TO postwave_app;

ALTER TABLE brand_voice_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_voice_profiles FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON brand_voice_profiles
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON brand_voice_profiles
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
