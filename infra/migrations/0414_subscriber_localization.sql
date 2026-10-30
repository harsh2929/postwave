-- 0414_subscriber_localization.sql
--
-- SUB-005 — Locale, language, country, region columns.
--
-- subscribers already carries a `timezone` column (migration 0172), read
-- internally by the quiet-hours checker but never surfaced in the Go
-- Subscriber struct or the API. For localization (date/number/currency
-- formatting, language-targeted sends) and commerce (tax/shipping by
-- country/region) we need four more attributes that do not exist today:
--
--   * locale    — BCP-47-ish free-text locale tag (e.g. "en-US", "pt-BR").
--   * language  — ISO 639-1 alpha-2 language code (e.g. "en", "pt").
--   * country   — ISO 3166-1 alpha-2 country code (e.g. "US", "BR").
--   * region    — free-text state/province/region (e.g. "California").
--
-- All four are nullable text. Unlike the name columns (0413), these are
-- genuinely optional per subscriber and "unknown" is a meaningful state, so
-- NULL (not '') is the right absence sentinel — the Go struct maps them to
-- *string and omits them from the JSON body when unset. No CHECK constraint
-- on the code shape: ISO validation is enforced at the application layer so
-- a drifting client can't 500 on an INSERT, and historical imports with
-- non-canonical codes still land.
--
-- A composite index on (tenant_id, country) supports the common
-- "subscribers in country X" segment/commerce filter as an index range scan
-- under the RLS tenant narrowing.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS locale   text,
    ADD COLUMN IF NOT EXISTS language text,
    ADD COLUMN IF NOT EXISTS country  text,
    ADD COLUMN IF NOT EXISTS region   text;

CREATE INDEX IF NOT EXISTS subscribers_tenant_country_idx
    ON subscribers (tenant_id, country)
    WHERE country IS NOT NULL;

COMMIT;
