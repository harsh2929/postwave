-- 0028_subscriber_engagement.sql
--
-- Cached engagement score columns on subscribers. Computed on-the-fly from
-- subscriber_events over the trailing 90 days; stored so list rendering can
-- avoid an N+1 events scan on every page paint.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN engagement_score    smallint,
    ADD COLUMN engagement_score_at timestamptz;

CREATE INDEX subscribers_engagement_idx
    ON subscribers (tenant_id, engagement_score DESC NULLS LAST);

COMMIT;
