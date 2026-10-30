-- 1401_campaign_conversion_goal.sql
--
-- G15 (campaigns 2026): per-campaign conversion goal + attribution
-- window. Binds a tracked conversion event (e.g. "checkout.complete")
-- and an attribution window to a campaign so the report can show
-- conversion_count / conversion_rate / attributed_revenue computed from
-- the conversions table (migration 0049) instead of the hardcoded 7-day
-- paid-subscriptions revenue figure.
--
-- Both columns nullable: legacy campaigns + campaigns without a goal
-- behave exactly as before (no goal section in the report).

BEGIN;

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS goal_event        text,
    ADD COLUMN IF NOT EXISTS goal_window_hours integer;

-- Constrain the window to the supported set (1h / 24h / 7d / 30d) when a
-- goal is configured. Guarded so a re-run doesn't error on the dup.
DO $$ BEGIN
    ALTER TABLE campaigns
        ADD CONSTRAINT campaigns_goal_window_hours_chk
        CHECK (goal_window_hours IS NULL OR goal_window_hours IN (1, 24, 168, 720));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
