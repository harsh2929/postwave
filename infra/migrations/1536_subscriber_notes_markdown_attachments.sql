-- 1536_subscriber_notes_markdown_attachments.sql
--
-- SUB-097: Notes tab with markdown / @-mentions / attachments.
--
-- The subscriber_notes table (0148) stores a plain-text `body`. The 2026
-- SOTA notes pane (Attio / Notion / Linear comment composers) renders
-- markdown, supports @-mentions of teammates, and lets operators drop
-- file attachments inline. This migration extends the existing row shape
-- so the same note can carry:
--
--   * markdown_body  — the rich source the composer round-trips. Mentions
--                      are stored as inline tokens `@[Name](user:UUID)`
--                      inside the markdown so the source is self-contained
--                      and renders without a join. `body` is kept as the
--                      plain-text projection (search / legacy clients).
--   * mentions_json  — a denormalised jsonb array of the mentioned user
--                      ids extracted from markdown_body at write time:
--                      [{"user_id":"<uuid>","display":"Jane"}]. Lets the
--                      "notify mentioned teammates" + "notes that mention
--                      me" surfaces query without re-parsing markdown.
--
-- Both columns are nullable / defaulted so existing rows and old clients
-- keep working. markdown_body is backfilled from body so the rich editor
-- has content on day one.

BEGIN;

ALTER TABLE subscriber_notes
    ADD COLUMN IF NOT EXISTS markdown_body text,
    ADD COLUMN IF NOT EXISTS mentions_json jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Backfill markdown_body from the plain body for pre-existing rows. The
-- guard keeps a re-run (test fixtures) from clobbering rows that already
-- have rich content.
UPDATE subscriber_notes
   SET markdown_body = body
 WHERE markdown_body IS NULL;

-- A note that mentions a teammate can be found by "notes mentioning me".
-- GIN over the jsonb array supports the @> containment lookup the
-- notification + inbox surfaces use.
CREATE INDEX IF NOT EXISTS idx_subscriber_notes_mentions
    ON subscriber_notes USING gin (mentions_json);

COMMIT;
