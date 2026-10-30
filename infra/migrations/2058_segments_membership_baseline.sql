-- 2058_segments_membership_baseline.sql
--
-- Give the segment membership cache its own "baseline written" instant.
--
-- SegmentEventWorker forwards a segment_joined event (the "Entered segment"
-- flow trigger) for every subscriber who matches a segment now but is not in
-- its segment_subscribers cache. That diff means something only against a cache
-- written for the segment's CURRENT definition. The worker inferred that from
-- `segments.last_evaluated_at IS NOT NULL` -- but last_evaluated_at is also the
-- list view's "Last evaluated" timestamp, and the manual recompute and the daily
-- size snapshot write it without touching the cache. After either, the next
-- subscriber event forwarded EVERY current member as a fresh entrant and
-- enrolled the whole segment in its entry flows.
--
-- membership_baseline_at is written only by the code that rewrites
-- segment_subscribers (segments.RefreshMembershipCache, shared by the event
-- worker and the send-time materialiser), in the same transaction as the
-- rewrite, and cleared when the definition changes. last_evaluated_at and
-- last_count become display-only, so evaluating a segment for the list view can
-- never again arm a mass enrolment.
--
-- NO BACKFILL, deliberately. No existing cache can be proven to belong to its
-- segment's current definition: a definition PATCH reset last_evaluated_at but
-- left the old definition's rows in place, and the snapshot worker re-set
-- last_evaluated_at without writing any rows. Starting every segment
-- un-baselined costs, at most, the entry events of one refresh per segment (the
-- first rewrite re-baselines without forwarding); guessing wrong would
-- mass-enrol. The materialiser picks un-baselined segments first, so the gap
-- closes within a few ticks of deploy.
--
-- migration-execution: transactional. Adding a nullable column without a
-- default is a catalog-only change; the ACCESS EXCLUSIVE lock is held for
-- milliseconds and lock_timeout bounds the wait behind a long reader.
-- rollback-strategy: no-op
-- rollback-details: Keep the column on an application rollback; earlier binaries never read it, and dropping it would reinstate the overloaded last_evaluated_at guard.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE segments
    ADD COLUMN IF NOT EXISTS membership_baseline_at timestamptz;

COMMENT ON COLUMN segments.membership_baseline_at IS
    'When segment_subscribers was last rewritten for this segment''s current '
    'definition. Set only by the membership-cache writers, cleared when '
    'query_ast changes. NULL means no baseline: the next rewrite must not '
    'forward segment_joined entrants. Not a display field; see last_evaluated_at.';

COMMIT;
