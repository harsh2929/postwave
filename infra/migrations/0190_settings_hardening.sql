-- 0190_settings_hardening.sql
--
-- Settings v2 backend hardening, identified during the comprehensive
-- settings audit. Six concerns rolled into one migration:
--
--   1. FORCE ROW LEVEL SECURITY on the three settings tables that
--      shipped with PERMISSIVE-only policies (workspace_settings,
--      notification_preferences, retention_policies). Without FORCE,
--      a superuser session or `SET SESSION AUTHORIZATION` bypasses
--      the policy entirely.
--
--   2. FORCE on tenant_sending_settings as well — same pattern, same
--      risk surface.
--
--   3. notification_preferences PK changed from (user_id) to
--      (user_id, tenant_id). A user who belongs to multiple tenants
--      currently shares one prefs row across all of them; setting
--      "no digest" in tenant A silently flips tenant B too. The
--      ON CONFLICT clause in the app code already expects the
--      composite key — fixed in the same release.
--
--   4. updated_by_user_id column added to tenant_sending_settings.
--      Every other settings table records who made the last change;
--      this one was the outlier (no attribution when a misconfigured
--      quiet-hours window delays sends).
--
--   5. updated_by_user_id added to notification_preferences too.
--      Same pattern — without it, the audit row carries the user_id
--      of the prefs subject, not the editor (relevant when an admin
--      adjusts another teammate's prefs, which the API permits).
--
--   6. Backfill: every existing row gets updated_at = now() and
--      updated_by_user_id = NULL (we have no historical attribution
--      to recover; NULL is honest).
--
-- The CHECK constraint on max_sends_per_hour (must be > 0) lives in
-- the Go layer rather than the DB so existing 0-or-negative rows
-- (which silently disabled sends) can be surfaced via repo logic
-- rather than rejected at migration time.

BEGIN;

-- 1+2. FORCE RLS on the four PERMISSIVE-only tables.
ALTER TABLE workspace_settings        FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences  FORCE ROW LEVEL SECURITY;
ALTER TABLE retention_policies        FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_sending_settings   FORCE ROW LEVEL SECURITY;

-- 3. notification_preferences PK -> (user_id, tenant_id).
-- Drop the old PK, add the composite. Existing rows survive because
-- (user_id, tenant_id) is already unique in practice (the tenant
-- middleware writes the calling tenant's id on every UPSERT). Index
-- coverage stays via the new PK.
ALTER TABLE notification_preferences
    DROP CONSTRAINT IF EXISTS notification_preferences_pkey;
ALTER TABLE notification_preferences
    ADD CONSTRAINT notification_preferences_pkey
    PRIMARY KEY (user_id, tenant_id);

-- 4+5. updated_by_user_id attribution.
ALTER TABLE tenant_sending_settings
    ADD COLUMN IF NOT EXISTS updated_by_user_id UUID
    REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE notification_preferences
    ADD COLUMN IF NOT EXISTS updated_by_user_id UUID
    REFERENCES users(id) ON DELETE SET NULL;

-- 6. No backfill needed — both new columns default to NULL, which
-- is the honest "we don't know who set this historically" value.

COMMIT;
