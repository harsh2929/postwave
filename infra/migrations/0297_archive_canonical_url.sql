-- 0297_archive_canonical_url.sql
--
-- archive-canonical-url (P2, surface=archive)
--
-- Buttondown ships Email.canonical_url for SEO. The column is
-- auto-populated for RSS-to-email ingested issues (pointing at the
-- original source URL), manually settable from the publish slideover,
-- and exposed to API callers via PublishInput. When set, the public
-- archive issue page renders `<link rel="canonical" href="…">` and
-- the RSS feed adds a per-item `<atom:link rel="canonical" href="…">`
-- so search engines de-duplicate the email-archive copy against the
-- original posting (HN cross-post, Medium re-publish, syndicated
-- partner blog, …).
--
-- Schema impact is tiny: a single nullable text column on `campaigns`.
-- Empty / NULL means "no canonical override — the archive permalink IS
-- the canonical". A non-empty value points search engines elsewhere.
--
-- No new table → no new RLS policy. The column rides on `campaigns`
-- which already has the canonical NULLIF tenant_id RLS policy.
--
-- Inspired by 2026 SOTA: Buttondown (Email.canonical_url), Ghost
-- (`canonical_url` on every post), Substack (per-post canonical link).

BEGIN;

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS archive_canonical_url text;

-- Length guard: full-URL columns get bounded so a buggy admin client
-- can't push arbitrary-size strings into the public-page <link> tag.
-- 2 KiB matches the de-facto URL cap modern browsers enforce (IE/Edge
-- historical limit) and is well above any realistic external URL.
ALTER TABLE campaigns
    ADD CONSTRAINT archive_canonical_url_max_len
    CHECK (archive_canonical_url IS NULL OR length(archive_canonical_url) <= 2048);

-- Shape guard: only http(s) URLs make it through. Empty string is
-- normalised to NULL by the application layer; an explicit non-empty
-- value MUST be a fully-qualified absolute URL or the constraint
-- rejects the row. This is a defence-in-depth check on top of
-- application-level validation.
ALTER TABLE campaigns
    ADD CONSTRAINT archive_canonical_url_scheme
    CHECK (archive_canonical_url IS NULL
           OR archive_canonical_url ~ '^https?://[^ ]+$');

COMMIT;
