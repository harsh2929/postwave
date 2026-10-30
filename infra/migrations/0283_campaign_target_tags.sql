-- 0283_campaign_target_tags.sql
--
-- Tags feature 12/12 — send-to-tag campaign targeting.
--
-- Campaigns can already target a list (audience_list_id) or a segment
-- (segment_id). Mailchimp lets operators target up to 5 tags directly
-- without authoring a segment first; this column carries that intent.
--
-- Resolution at send-time UNIONs subscribers from subscriber_tags
-- (migration 0244) into the recipient set ahead of the segment-AST
-- compile path. Empty array means "no tag targeting".
--
-- Why uuid[] over a join table: the cardinality is small (max 5 per
-- campaign, enforced in apps/api/internal/campaigns types validation)
-- and the column is read in every send path, so co-locating with the
-- campaign row avoids an extra round-trip. Mirrors the existing
-- reusable_section_ids uuid[] pattern.

BEGIN;

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS target_tag_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

COMMENT ON COLUMN campaigns.target_tag_ids IS
    'Up to 5 tag ids to target directly. UNIONed into the recipient set at send-time. Empty = no tag targeting.';

-- GIN index over the small array — keeps "which campaigns target tag X"
-- audit queries cheap when tag detail slideovers need to list usage.
CREATE INDEX IF NOT EXISTS campaigns_target_tag_ids_gin
    ON campaigns USING gin (target_tag_ids)
    WHERE array_length(target_tag_ids, 1) > 0;

COMMIT;
