-- 0137_lead_scoring.sql
--
-- Lead-scoring engine. Each tenant configures a set of rules
-- (event_type → weight) and a recurring worker walks
-- subscriber_events to roll up a single integer score per
-- subscriber that downstream segments / automations can branch on.
--
-- Example rules:
--   opened       +1
--   clicked      +5
--   complained   -50
--   bounced      -10
--   form_submit  +10
--
-- The score lives on subscribers.engagement_score so existing
-- segments + automations can SELECT it directly. The worker
-- recomputes the score in batches; tenants with thousands of
-- subscribers see fresh scores within minutes.
--
-- Default rules (when scoring_rules is empty) approximate
-- Mailchimp's behavior: +1 open, +5 click, +10 form, -10 bounce,
-- -50 complaint. Operators override per tenant.

BEGIN;

-- Per-subscriber score column. NOT NULL DEFAULT 0 so existing rows
-- need no backfill — they'll start at zero and trend up as the
-- worker rolls forward.
ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS engagement_score int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS engagement_score_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_subscribers_engagement_score
    ON subscribers (tenant_id, engagement_score DESC);

-- Rules table. One row per (tenant, event_type) — UNIQUE so the
-- upsert path is clean. Decay isn't supported in V1 (KISS) — the
-- worker recomputes from the last 90 days of events, which gives
-- a natural recency bias without a per-event timestamp weight.
CREATE TABLE IF NOT EXISTS scoring_rules (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    event_type  text NOT NULL,
    weight      int  NOT NULL,
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_scoring_rules_tenant
    ON scoring_rules (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON scoring_rules TO postwave_app;

ALTER TABLE scoring_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON scoring_rules AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
