-- 0310_archive_comments_threaded.sql
--
-- archive-comments-threaded (P2, surface=archive)
--
-- Native threaded commenting on published archive issues with
-- multi-level reply nesting, up/down voting, pinned comments, smart
-- sort, and a dedicated moderation dashboard. Parity with Ghost
-- (Members commenting), Buttondown (built-in comments + admin
-- moderation), and Substack (threaded reader discussion).
--
-- Two tables:
--
--  1. `archive_comments` — the comment tree itself, keyed by uuid with
--     a self-referencing `parent_comment_id` pointing at the parent
--     for replies. `subscriber_id` is NULLABLE so guest comments
--     (display_name only) can be permitted alongside subscriber-bound
--     comments. `pinned` lets an operator float a featured comment
--     to the top of the thread regardless of sort.  `status` carries
--     moderation state: 'visible' (default), 'pending' (held for
--     review), 'hidden' (operator-removed), 'spam' (auto/manual
--     classifier hit). Soft-deletion is intentional — Ghost/Substack
--     both keep the row so reply chains don't collapse mid-thread.
--
--  2. `archive_comment_votes` — one vote per (comment_id, subscriber_id)
--     with vote ∈ {-1, +1}.  Re-voting the same direction is a no-op
--     (UNIQUE prevents duplicate inserts); flipping direction
--     overwrites in place via the ON CONFLICT path in the repo.
--     Guest votes are not supported (subscriber_id is NOT NULL) since
--     guest votes would require per-IP throttling that this initial
--     drop intentionally defers.
--
-- RLS: standard tenant pair (RESTRICTIVE + PERMISSIVE) using the
-- `NULLIF(current_setting('app.tenant_id', true), '')::uuid` idiom so
-- an unset GUC doesn't crash the cast. The public surface uses
-- db.WithTenant to set the GUC on the resolved tenant id (from the
-- tenant_archive_slug path param) — the comment list/post endpoints
-- never look up arbitrary tenants.
--
-- Indices:
--   - tenant + campaign + created_at (DESC) for the threaded list
--     under a campaign issue page.
--   - tenant + status + created_at (DESC) for the moderation
--     dashboard's "pending/hidden/spam" tabs.
--   - parent_comment_id for sub-thread expansion.
--   - votes: (comment_id) for per-comment tally rollup.

BEGIN;

-- 1. archive_comments — the threaded comment tree.
CREATE TABLE IF NOT EXISTS archive_comments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id         uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    parent_comment_id   uuid REFERENCES archive_comments(id) ON DELETE CASCADE,
    -- Nullable: a guest comment (operator opts in via tenant settings)
    -- has display_name + no subscriber row. ON DELETE SET NULL so
    -- removing a subscriber doesn't tombstone their thread of replies.
    subscriber_id       uuid REFERENCES subscribers(id) ON DELETE SET NULL,
    -- Free-form display name. For subscriber-bound comments this is
    -- copied at insert time from subscribers.name so a later rename
    -- doesn't retroactively rewrite history. For guest comments it's
    -- whatever the public form accepted (validated server-side: 1..80
    -- chars, no control bytes).
    display_name        text NOT NULL DEFAULT '',
    -- The comment body itself. Plain text in this initial drop;
    -- markdown rendering can be layered in a follow-up without a
    -- schema change. Hard cap 4000 chars enforced in the repo.
    body                text NOT NULL,
    -- Operator-pinned floats this comment above all others in the
    -- thread regardless of the chosen sort. Pinning a reply pins the
    -- reply within its parent's sub-thread, not the whole page.
    pinned              boolean NOT NULL DEFAULT false,
    -- Moderation state. Default 'visible' so the canonical happy
    -- path (operator hasn't enabled pre-moderation) emits a comment
    -- straight into the thread.
    status              text NOT NULL DEFAULT 'visible'
                        CHECK (status IN ('visible','pending','hidden','spam')),
    -- Denormalised vote tallies for cheap list rendering. Updated
    -- by the repo's vote helper on every insert/flip/clear so the
    -- list endpoint doesn't need a per-row aggregate JOIN. A drift
    -- repair is a future concern (cron + recompute), not in scope.
    upvotes             integer NOT NULL DEFAULT 0,
    downvotes           integer NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS archive_comments_campaign_idx
    ON archive_comments (tenant_id, campaign_id, created_at DESC);

CREATE INDEX IF NOT EXISTS archive_comments_moderation_idx
    ON archive_comments (tenant_id, status, created_at DESC)
    WHERE status <> 'visible';

CREATE INDEX IF NOT EXISTS archive_comments_parent_idx
    ON archive_comments (parent_comment_id)
    WHERE parent_comment_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON archive_comments TO postwave_app;

ALTER TABLE archive_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_comments FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON archive_comments
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON archive_comments
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2. archive_comment_votes — one (comment, subscriber) row per vote.
CREATE TABLE IF NOT EXISTS archive_comment_votes (
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    comment_id     uuid NOT NULL REFERENCES archive_comments(id) ON DELETE CASCADE,
    subscriber_id  uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    -- +1 = upvote, -1 = downvote. CHECK constraint guarantees we
    -- never accept 0 (a "clear vote" is a DELETE, not an update to 0).
    vote           smallint NOT NULL CHECK (vote IN (-1, 1)),
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (comment_id, subscriber_id)
);

CREATE INDEX IF NOT EXISTS archive_comment_votes_comment_idx
    ON archive_comment_votes (comment_id);

CREATE INDEX IF NOT EXISTS archive_comment_votes_subscriber_idx
    ON archive_comment_votes (subscriber_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON archive_comment_votes TO postwave_app;

ALTER TABLE archive_comment_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_comment_votes FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON archive_comment_votes
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON archive_comment_votes
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
