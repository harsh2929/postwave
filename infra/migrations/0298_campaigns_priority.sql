-- 0298_campaigns_priority.sql
--
-- sto-message-prioritization (P2): workspace-level Message Prioritization
-- inspired by Braze. When a subscriber is eligible for multiple sends
-- within the same window (frequency cap, send-time-optimization slot,
-- or queue-fill batch), higher-priority sends win. Lower-priority
-- promos that would breach the cap are skipped at queue-fill time.
--
-- Schema:
--
--   campaigns.priority — integer in [1..10]; DEFAULT 5 ("normal
--     marketing"). Transactional / system mailings are expected to be
--     pinned at 10 (the highest); pure promos at 1-3. The dispatcher
--     sorts overlapping recipients DESC by priority and skips the
--     loser when a frequency-cap-style window cap would be breached.
--
-- Backfill semantics: existing rows get the default 5. Operator can
-- raise individual campaigns via PATCH /api/v1/campaigns/{id} once
-- this lands. No data migration required.
--
-- A CHECK constraint pins the range so a misbehaving client can't
-- shove priority=999 and starve every other campaign.

BEGIN;

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 5;

-- CHECK constraint: priority in [1..10]. Guarded with NOT EXISTS so
-- re-running the migration is safe; PostgreSQL doesn't have IF NOT
-- EXISTS on ADD CONSTRAINT.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'campaigns_priority_range_check'
    ) THEN
        ALTER TABLE campaigns
            ADD CONSTRAINT campaigns_priority_range_check
            CHECK (priority BETWEEN 1 AND 10);
    END IF;
END$$;

-- Helps the dispatcher sort overlapping candidates by priority across
-- a tenant without a full scan. Partial: only "active" statuses
-- (scheduled/sending) ever participate in the collision resolution.
CREATE INDEX IF NOT EXISTS campaigns_tenant_priority_idx
    ON campaigns (tenant_id, priority DESC)
    WHERE status IN ('scheduled', 'sending');

COMMIT;
