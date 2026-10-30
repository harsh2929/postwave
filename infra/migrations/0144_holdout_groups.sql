-- 0144_holdout_groups.sql
--
-- Holdout groups for incremental-lift measurement.
--
-- The marketing-attribution problem: when a campaign goes out and
-- conversions follow, you don't know how many would have happened
-- anyway. Industry solution: randomly hold back N% of the audience
-- (the "control"), send only to the (100-N)%, and compare
-- conversion rates over the next 1-30 days.
--
-- One row per campaign declares the holdout intent:
--   * percent       random fraction to hold back (0..50)
--   * seed          deterministic random seed so the same subscriber
--                   is in/out across re-sends of the same campaign
--   * decided_at    when the dispatcher locked in the holdout (so
--                   conversions before this don't count)
--
-- Per-subscriber assignment is computed on the fly via a
-- deterministic hash:
--   md5(holdout_seed || subscriber_id) ranged into [0, 100)
-- which gives a stable boolean without a per-subscriber row.

BEGIN;

CREATE TABLE IF NOT EXISTS campaign_holdouts (
    campaign_id     uuid PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The fraction held back. 0 means the row exists but no holdout
    -- (operator may want a record for the audit trail anyway).
    percent         numeric(5,2) NOT NULL CHECK (percent >= 0 AND percent <= 50),
    -- Deterministic seed for in/out assignment. Generated at create.
    seed            text NOT NULL,
    -- Set when the dispatcher reads the holdout for the first time.
    decided_at      timestamptz,
    -- How many subscribers were excluded (cached after decide).
    held_out_count  int NOT NULL DEFAULT 0,
    -- How many were sent to.
    sent_count      int NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaign_holdouts_tenant
    ON campaign_holdouts (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_holdouts TO postwave_app;

ALTER TABLE campaign_holdouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_holdouts AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
