-- 0281_archive_tenant_settings_meta.sql
--
-- Add SEO/branding metadata columns to tenant_public_settings so the new
-- admin "Archive settings" form (gap feature `archive-tenant-slug-write`)
-- can persist publication-level fields alongside the existing
-- `tenant_archive_slug` + `archive_domain`. Without these columns, new
-- tenants would still 404 every archive URL until SQL was run by hand.
--
-- Field semantics (mirrors Substack / beehiiv / Ghost publication
-- settings):
--   - archive_title   — display heading on the public archive landing
--                       page (e.g. "Postwave Weekly").
--   - archive_tagline — short subtitle / pitch under the title
--                       (e.g. "Notes on email infrastructure").
--
-- Both are nullable so existing rows keep working; the public archive
-- read path falls back to the tenant name + a generic tagline when
-- either column is NULL.

BEGIN;

ALTER TABLE tenant_public_settings
    ADD COLUMN IF NOT EXISTS archive_title   text,
    ADD COLUMN IF NOT EXISTS archive_tagline text;

COMMIT;
