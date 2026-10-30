-- 1408_campaign_frozen_freeze.sql
--
-- G6 follow-up: link a campaign to its static-audience freeze. When
-- audience_mode='static', the campaign sends to the frozen membership
-- snapshot (segment_static_freezes, migration 0252) rather than
-- re-evaluating the segment at send time.

BEGIN;

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS frozen_freeze_id uuid;

COMMIT;
