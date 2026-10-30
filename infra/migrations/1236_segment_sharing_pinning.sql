-- 1236_segment_sharing_pinning.sql
--
-- SUB-040 — segment sharing / pinning / ordering. Extends the
-- saved_segments bookmark table (migration 0224) with the columns the
-- 2026 segment-organizer UI needs:
--
--   * is_pinned       — operator pins a saved segment to the top of the
--                       picker; pinned-first sort.
--   * pin_order       — manual drag-to-reorder position WITHIN the
--                       pinned group (lower = higher). NULL when unpinned.
--   * visibility_scope — 'personal' (only the creator sees it) vs
--                       'workspace' (every tenant member sees it). The
--                       column is the source of truth; the desktop reads
--                       it to decide which bookmarks to surface. Pinned to
--                       a CHECK so drifting clients cannot land a junk
--                       value.
--   * created_by_user_id — links the bookmark to the user who saved it
--                       (FK users, ON DELETE SET NULL so a removed user
--                       leaves the workspace bookmark intact). Nullable
--                       because legacy rows + API-key writes have no user.
--
-- 2026 SOTA references:
--   * Klaviyo — pin/favorite a segment to the top of the list; segments
--     are workspace-shared by default.
--   * Mailchimp — "Saved segments" can be shared across the audience or
--     kept to the author.
--
-- All additive + nullable so the existing CRUD keeps working untouched.

BEGIN;

ALTER TABLE saved_segments
    ADD COLUMN IF NOT EXISTS is_pinned          boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS pin_order          integer,
    ADD COLUMN IF NOT EXISTS visibility_scope   text NOT NULL DEFAULT 'personal',
    ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'saved_segments_visibility_scope_chk'
    ) THEN
        ALTER TABLE saved_segments
            ADD CONSTRAINT saved_segments_visibility_scope_chk
            CHECK (visibility_scope IN ('personal', 'workspace'));
    END IF;
END$$;

-- Pinned-first ordering index. Composite on (tenant_id, is_pinned DESC,
-- pin_order ASC) so the RLS-narrowed list query plans the pinned-first
-- sort directly without a separate tenant lookup.
CREATE INDEX IF NOT EXISTS saved_segments_tenant_pinned_idx
    ON saved_segments (tenant_id, is_pinned DESC, pin_order ASC);

COMMIT;
