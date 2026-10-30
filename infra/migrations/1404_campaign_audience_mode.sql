-- 1404_campaign_audience_mode.sql
--
-- G6 (campaigns 2026): audience picker — static-snapshot vs dynamic.
-- audience_mode records whether the campaign's audience is frozen at
-- compose time ('static') or re-evaluated at send time ('dynamic',
-- today's behaviour). The static-snapshot materialization into
-- segment_static_freezes (migration 0252) + the send-path read are the
-- documented follow-up; this column persists the operator's choice.

BEGIN;

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS audience_mode text NOT NULL DEFAULT 'dynamic';

DO $$ BEGIN
    ALTER TABLE campaigns
        ADD CONSTRAINT campaigns_audience_mode_chk
        CHECK (audience_mode IN ('static', 'dynamic'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
