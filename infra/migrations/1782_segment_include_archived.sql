-- 1782_segment_include_archived.sql
--
-- SEG-034: persist the segment builder's archive-scope toggle on the segment
-- definition. Previously `include_archived` was a per-request preview input
-- only, so re-opening a saved segment always reset to active-only and the
-- stored last_count never reflected an archived-inclusive definition.
--
-- A nullable-free boolean defaulting to false keeps every existing segment
-- fail-closed to active (non-archived) profiles — the safe default. Real
-- activation (campaign/flow population) continues to force-exclude archived
-- regardless of this column (see evaluator.go: IncludeArchived is invalid for
-- activation), so this only affects the preview/count/recompute context.
ALTER TABLE segments
    ADD COLUMN IF NOT EXISTS include_archived boolean NOT NULL DEFAULT false;
