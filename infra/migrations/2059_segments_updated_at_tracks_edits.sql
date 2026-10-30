-- 2059_segments_updated_at_tracks_edits.sql
--
-- Stop evaluations from counting as edits of a segment.
--
-- segments.updated_at is the segment's edit version: the web and desktop
-- editors send it back as If-Match (httpcache.ConcurrencyToken), the list
-- orders by it, and the size writers pin their counts to it so a count of one
-- definition never lands on another. But `segments_set_updated_at` (0014)
-- stamped now() on EVERY update, including the ones that only record a count or
-- a cache baseline: the manual recompute, the daily size snapshot, the event
-- worker (about a second after each subscriber event) and the send-time
-- materialiser. Each of those silently invalidated the ETag an open editor was
-- holding, so saving after any background evaluation failed with 412, and the
-- list reshuffled as workers ran. Evaluating a segment when it is saved would
-- have made the very first save after creating one fail the same way.
--
-- The trigger now fires only when something other than the evaluation columns
-- (last_count, last_evaluated_at, membership_baseline_at) changes. Comparing
-- the whole row minus those columns means a column added later counts as an
-- edit by default, which is the safe direction. An UPDATE that sets updated_at
-- itself (Repo.Update does) keeps doing so.
--
-- migration-execution: transactional. Replacing a trigger takes a brief
-- SHARE ROW EXCLUSIVE lock on segments; lock_timeout bounds the wait.
-- rollback-strategy: no-op
-- rollback-details: Keep the gated trigger on an application rollback; earlier binaries only write these columns through statements the gate is meant to ignore.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS segments_set_updated_at ON segments;

CREATE TRIGGER segments_set_updated_at
    BEFORE UPDATE ON segments
    FOR EACH ROW
    WHEN ((to_jsonb(OLD) - ARRAY['updated_at', 'last_count', 'last_evaluated_at', 'membership_baseline_at'])
          IS DISTINCT FROM
          (to_jsonb(NEW) - ARRAY['updated_at', 'last_count', 'last_evaluated_at', 'membership_baseline_at']))
    EXECUTE FUNCTION set_updated_at();

COMMENT ON TRIGGER segments_set_updated_at ON segments IS
    'Stamps updated_at when a segment is edited. Recording a count or a '
    'membership-cache baseline (last_count, last_evaluated_at, '
    'membership_baseline_at) is not an edit and leaves the version alone.';

COMMIT;
