-- 0143_domain_warmup_plans.sql
--
-- Domain warmup planner.
--
-- New sending domains start with zero reputation at the inbox
-- providers. Sending the full list on day 1 trips every spam
-- filter. The industry pattern is a 21-30 day ramp: start at
-- ~50/day, double daily until the provider's volume budget for
-- the domain is reached.
--
-- IP warmup (sending/dedicated_ip*) handles the network layer;
-- domain warmup handles the DKIM-signed identity. They are
-- distinct concerns:
--   * IP   = "this network can send"      (Postmark/Mailgun manages)
--   * Dom. = "this From: identity is real" (operator manages here)
--
-- A plan has a (tenant_id, domain) one-to-one with
-- sending_identities. Each row stores the target steady-state
-- daily volume and the day-by-day schedule as a jsonb array.
-- The dispatcher consults today_quota_remaining() to decide
-- whether to throttle.

BEGIN;

CREATE TABLE IF NOT EXISTS domain_warmup_plans (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    domain          text NOT NULL,
    -- Steady-state volume the operator wants to reach by day N.
    target_daily    int NOT NULL CHECK (target_daily > 0),
    -- Plan length in days.
    days            int NOT NULL DEFAULT 30 CHECK (days BETWEEN 7 AND 90),
    -- ISO date of day 1 of the ramp.
    started_on      date NOT NULL DEFAULT CURRENT_DATE,
    -- Status:
    --   active      ramping
    --   completed   target reached and elapsed_days >= days
    --   paused      operator paused (e.g. complaint spike)
    --   cancelled   operator abandoned the plan
    status          text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','completed','paused','cancelled')),
    -- Daily plan stored as jsonb array of ints:
    --   [50, 100, 200, 400, 800, ...]
    -- index = day-1 (0-indexed) into the ramp.
    schedule        jsonb NOT NULL,
    -- Cached observation for the dashboard. The worker updates it
    -- after each daily reconciliation pass.
    last_sent_count int NOT NULL DEFAULT 0,
    last_observed_at timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_domain_warmup_plans_tenant_status
    ON domain_warmup_plans (tenant_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON domain_warmup_plans TO postwave_app;

ALTER TABLE domain_warmup_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON domain_warmup_plans AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
