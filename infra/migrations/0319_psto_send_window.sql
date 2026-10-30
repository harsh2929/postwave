-- 0319_psto_send_window.sql
--
-- G5 (campaigns 2026): per-recipient send-time within a send window
-- (PSTO). Klaviyo-flagship feature; closes the parity gap with the
-- ActiveCampaign Predictive Sending / Klaviyo Personalized Send Time
-- features that shipped through 2024-2025.
--
-- Backbone schema additions only — the scheduler that consults
-- send_time_opt.best_send_hour to release the queue gradually lives
-- in a G5 follow-up commit. The desktop Schedule modal gains a
-- toggle that PATCHes campaigns.per_recipient_optimize=true with a
-- window_start/window_end pair, and the read endpoint surfaces the
-- decision to the API so older deploys parsing the response by name
-- stay forward-compatible.

BEGIN;

-- New optional columns on campaigns. All nullable / default-false so
-- legacy rows behave identically (per_recipient_optimize=false,
-- send_window_start=NULL, send_window_end=NULL = "fire at scheduled_at
-- like always").
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS per_recipient_optimize boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS send_window_start      timestamptz,
    ADD COLUMN IF NOT EXISTS send_window_end        timestamptz;

-- Materialization table: one row per (campaign, subscriber) carrying
-- the chosen scheduled_send_at within the window. Populated by the
-- PSTO scheduler in a G5 follow-up; the existing send loop drains
-- the campaign_recipients table per second, so PSTO needs its own
-- staging counter that the loop consults before claiming rows.
CREATE TABLE IF NOT EXISTS campaign_recipient_send_at (
    id                 bigserial   PRIMARY KEY,
    tenant_id          uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id        uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    subscriber_email   citext      NOT NULL,
    scheduled_send_at  timestamptz NOT NULL,
    sent_at            timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
);

-- Drain index: scheduler claims rows where scheduled_send_at <= now()
-- AND sent_at IS NULL, ordered by scheduled_send_at to fire the
-- oldest-due first. Partial index keeps it small because most rows
-- become sent_at IS NOT NULL quickly.
CREATE INDEX IF NOT EXISTS campaign_recipient_send_at_due_idx
    ON campaign_recipient_send_at (tenant_id, scheduled_send_at)
    WHERE sent_at IS NULL;

-- Uniqueness: a recipient should only appear once per campaign on the
-- materialized table. Re-queues that re-resolve the audience should
-- ON CONFLICT-update the scheduled_send_at rather than insert a dup.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_recipient_send_at_pair_uq
    ON campaign_recipient_send_at (campaign_id, subscriber_email);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_recipient_send_at TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE campaign_recipient_send_at_id_seq TO postwave_app;

ALTER TABLE campaign_recipient_send_at ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipient_send_at FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON campaign_recipient_send_at
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON campaign_recipient_send_at
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
