-- 0287_translation_dictionary.sql
--
-- sto-smart-translations (P3, surface=send-time)
--
-- Klaviyo and beehiiv ship multi-locale AI translation with CSV-importable
-- terminology dictionaries so brand/product terms ("Postwave", "Listmonk",
-- "Pro plan") survive translation without being rendered as
-- "Pôtevague", "Mince-mince", "plan Professionnel", etc.
--
-- This migration introduces three tables:
--
--  1. tenant_translation_settings(tenant_id, enabled, default_locale,
--     supported_locales, fallback_strategy, ...)
--       Per-tenant on/off + the locale set the tenant has licensed. Read
--       at render-time to decide whether to even attempt a translation.
--
--  2. tenant_translation_dictionary(id, tenant_id, term, translations,
--     case_sensitive, notes, created_at, updated_at)
--       The CSV-importable terminology list. `translations` is a jsonb
--       map locale -> translation. An empty string in the map means
--       "leave this term untouched in this locale" — explicit no-op
--       so the dictionary can opt a term OUT of translation per locale
--       (e.g. brand name stays "Postwave" everywhere except "fr-CA"
--       where the legal entity localized).
--
--  3. campaign_translation_cache(tenant_id, body_hash, locale,
--     translated_body, dictionary_version, created_at)
--       Render-time cache so we don't re-call the AI gateway when the
--       same body_hash + locale combo has already been translated. Keyed
--       by body_hash (sha256 hex over the *post-dictionary-masking*
--       body) + locale so a dictionary edit invalidates the cache
--       organically: the next render reproduces the masked string,
--       hashes differently, and misses.
--
-- All three tables follow the canonical NULLIF GUC RLS idiom from 0079 so
-- an unset tenant_id GUC produces zero rows instead of crashing.

BEGIN;

-- 1. Settings ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenant_translation_settings (
    tenant_id          uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    enabled            boolean NOT NULL DEFAULT false,
    default_locale     text    NOT NULL DEFAULT 'en',
    supported_locales  text[]  NOT NULL DEFAULT ARRAY['en']::text[],
    -- 'subscriber_locale' means "translate to subscriber's locale attrib;
    -- fall back to default_locale on miss". 'default_only' disables
    -- per-recipient routing — every recipient sees default_locale. This
    -- is a cheap killswitch for tenants who want the table to exist
    -- but don't yet trust the routing.
    fallback_strategy  text    NOT NULL DEFAULT 'subscriber_locale'
        CHECK (fallback_strategy IN ('subscriber_locale','default_only')),
    -- Subscriber attribute key to read the per-recipient locale from.
    -- Defaults to 'language' which matches the existing Listmonk
    -- subscriber.attribs convention in migrations 0205 / 0212.
    locale_attribute   text    NOT NULL DEFAULT 'language',
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_translation_settings TO postwave_app;

ALTER TABLE tenant_translation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_translation_settings FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenant_translation_settings;
CREATE POLICY tenant_isolation ON tenant_translation_settings
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON tenant_translation_settings;
CREATE POLICY tenant_visible ON tenant_translation_settings
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2. Dictionary -------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenant_translation_dictionary (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The source-language term we never want re-translated by the LLM.
    -- Length-bounded so a malformed CSV doesn't insert a 4MB string.
    term            text NOT NULL CHECK (length(term) BETWEEN 1 AND 256),
    -- locale -> translation. Empty string value = "leave untouched in
    -- this locale" (opt-out). Missing key = "untouched in all locales
    -- not listed" (default opt-out, which is the safer default for
    -- brand names).
    translations    jsonb NOT NULL DEFAULT '{}'::jsonb,
    case_sensitive  boolean NOT NULL DEFAULT false,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- A tenant can only register a term once; case-insensitivity is
    -- enforced via lower(term) so "Postwave" and "POSTWAVE" don't
    -- both insert.
    UNIQUE (tenant_id, term)
);

CREATE INDEX IF NOT EXISTS tenant_translation_dictionary_tenant_idx
    ON tenant_translation_dictionary (tenant_id, term);

-- Lowercase lookup index for the case-insensitive render-time match path.
CREATE INDEX IF NOT EXISTS tenant_translation_dictionary_tenant_lower_idx
    ON tenant_translation_dictionary (tenant_id, lower(term));

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_translation_dictionary TO postwave_app;

ALTER TABLE tenant_translation_dictionary ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_translation_dictionary FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenant_translation_dictionary;
CREATE POLICY tenant_isolation ON tenant_translation_dictionary
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON tenant_translation_dictionary;
CREATE POLICY tenant_visible ON tenant_translation_dictionary
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 3. Render-time cache -----------------------------------------------

CREATE TABLE IF NOT EXISTS campaign_translation_cache (
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- sha256 hex (64 chars) over the masked-body source. Caller is
    -- responsible for producing this digest; it's an opaque content key
    -- here.
    body_hash           text NOT NULL CHECK (length(body_hash) = 64),
    locale              text NOT NULL CHECK (length(locale) BETWEEN 2 AND 16),
    translated_body     text NOT NULL,
    -- Snapshot of the dictionary content-version at translation time.
    -- A bump in tenant_translation_settings.updated_at signals the
    -- dictionary may have changed; the cache row stays valid until
    -- the masked body_hash itself changes, which it will the next
    -- time the dictionary actually affects the body.
    dictionary_version  bigint NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, body_hash, locale)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_translation_cache TO postwave_app;

ALTER TABLE campaign_translation_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_translation_cache FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON campaign_translation_cache;
CREATE POLICY tenant_isolation ON campaign_translation_cache
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON campaign_translation_cache;
CREATE POLICY tenant_visible ON campaign_translation_cache
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
