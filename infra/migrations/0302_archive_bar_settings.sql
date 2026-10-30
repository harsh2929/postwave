-- 0302_archive_bar_settings.sql
--
-- archive-mailchimpv3-archive-bar (P2, surface=archive)
--
-- Mailchimp's Archive Bar is a persistent in-email strip that lets a
-- reader "View this email in your browser" and "View past issues" from
-- the same template chrome. Ghost ships the equivalent as the
-- `{{ view_url }}` Handlebars helper in its default newsletter.
-- Postwave previously had neither: every default body shipped without a
-- View-in-browser link and without an Archive entry-point.
--
-- This migration adds the tenant-level defaults that drive the
-- rendered Archive Bar + View-in-browser link. The per-campaign
-- override lives in `campaigns.delivery_settings` as a jsonb key
-- (`archive_bar_enabled` / `view_in_browser_enabled`) so we don't
-- need a column-add for an optional, low-volume toggle.
--
-- Columns added to `tenant_public_settings`:
--
--   - archive_bar_default_enabled  — bool, default true. Default-on
--                                    in template scaffolds, matching
--                                    Mailchimp's documented default.
--                                    Per-campaign override wins when
--                                    delivery_settings.archive_bar_enabled
--                                    is set (true/false).
--   - archive_bar_default_text     — text, optional. The CTA copy
--                                    rendered in the archive bar. Empty
--                                    falls back to the package default
--                                    ("View this email in your browser
--                                    | View past issues").
--   - view_in_browser_default_enabled — bool, default true. Toggles
--                                    the standalone `{{ view_in_browser_url }}`
--                                    fallback link rendered next to the
--                                    unsubscribe link in the default
--                                    footer template.
--
-- RLS already exists on tenant_public_settings (see migration 0152's
-- NULLIF GUC fix). No new policies needed; the columns inherit the
-- table-level RESTRICTIVE/PERMISSIVE policies from the existing
-- tenant_isolation + tenant_visible policies.

BEGIN;

ALTER TABLE tenant_public_settings
    ADD COLUMN IF NOT EXISTS archive_bar_default_enabled    boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS archive_bar_default_text       text,
    ADD COLUMN IF NOT EXISTS view_in_browser_default_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN tenant_public_settings.archive_bar_default_enabled IS
    'archive-mailchimpv3-archive-bar: default-on toggle for the Mailchimp-parity Archive Bar rendered in email templates. Per-campaign override lives in campaigns.delivery_settings.archive_bar_enabled.';
COMMENT ON COLUMN tenant_public_settings.archive_bar_default_text IS
    'archive-mailchimpv3-archive-bar: optional CTA copy for the Archive Bar. Empty falls back to the package default ("View this email in your browser | View past issues").';
COMMENT ON COLUMN tenant_public_settings.view_in_browser_default_enabled IS
    'archive-mailchimpv3-archive-bar: default-on toggle for the standalone {{ view_in_browser_url }} link rendered next to the unsubscribe link in the default footer.';

COMMIT;
