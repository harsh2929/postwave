-- 1512_saved_segments_last_count.sql
--
-- SUB-084 — saved segment row counts. Display live membership next to each
-- saved-segment name in the SavedSegmentsManager grid.
--
-- The full `segments` table already carries last_count / last_evaluated_at
-- (migration 0014) maintained aggressively by the snapshot + event workers.
-- The `saved_segments` bookmark table (migration 0224) has no such
-- denormalised count, so the SavedSegmentsManager can only show a count by
-- firing a per-segment preview request. This migration mirrors the segments
-- shape onto saved_segments so the list query can return a stored count
-- inline, and the preview path (PreviewSaved / PreviewSavedDetail) writes the
-- freshly-computed count back so subsequent loads reflect live state.
--
--   * last_count        — denormalised membership size from the most recent
--                         preview/evaluation. NULL = never evaluated (the
--                         badge renders "—"); a populated value renders
--                         "<n> member(s)".
--   * last_evaluated_at — when last_count was written. NULL = never. The UI
--                         pairs this with the count ("123 members · 2h ago")
--                         so an operator can judge staleness.
--
-- STALE-READ NOTE: unlike `segments`, saved_segments has no background
-- recompute worker yet (SUB-029 is partial). last_count is only refreshed on
-- an explicit preview/recount click, so the stored value can lag. The UI
-- surfaces last_evaluated_at alongside the count and offers a manual refresh.
--
-- Both columns are additive + nullable, so the existing saved-segment CRUD
-- (List/Get/Create/Patch/Delete) keeps working untouched. saved_segments is
-- already tenant-scoped with RLS enabled (migration 0224), so the new columns
-- inherit tenant isolation — no new policy is required.

BEGIN;

ALTER TABLE saved_segments
    ADD COLUMN IF NOT EXISTS last_count        integer,
    ADD COLUMN IF NOT EXISTS last_evaluated_at timestamptz;

COMMIT;
