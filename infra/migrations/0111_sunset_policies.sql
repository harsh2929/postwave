-- 0109_sunset_policies.sql
--
-- Sunset policies: per-tenant rules for what to do with subscribers
-- who've stopped engaging. The detector runs on a cron, finds
-- candidates whose last engagement is older than InactiveDays, and
-- executes the configured Action (suppress / tag / winback).
--
-- We separate the policy (rule definition, edited by the customer)
-- from the execution log (one row per (subscriber, policy) the
-- detector has acted on) so re-runs are idempotent and the dashboard
-- can show "X subscribers sunsetted this week" without rescanning.

BEGIN;

CREATE TABLE IF NOT EXISTS sunset_policies (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL,
  name            text        NOT NULL,
  -- Inactivity window: candidates are subscribers whose last opened/
  -- clicked/replied event is older than this many days. NULL last_seen
  -- is treated as "older than InactiveDays" so brand-new imports that
  -- never engaged get caught too (per industry default — Mailchimp
  -- and Klaviyo behave the same).
  inactive_days   integer     NOT NULL DEFAULT 180
                                CHECK (inactive_days BETWEEN 30 AND 730),
  -- Action: what the detector does to a candidate.
  --   'suppress' adds the address to email_suppressions immediately;
  --   'tag'      writes a "sunset_candidate" tag for manual review;
  --   'winback'  enqueues a re-engagement campaign via the
  --              winback_candidate_queue table below.
  action          text        NOT NULL DEFAULT 'tag'
                                CHECK (action IN ('suppress','tag','winback')),
  enabled         boolean     NOT NULL DEFAULT true,
  -- excluded_tags: subscribers carrying ANY of these tags are
  -- skipped by the detector (e.g. VIP, customer, paying). Stored as
  -- text[] for set-overlap operators.
  excluded_tags   text[]      NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sunset_policies_tenant_idx
  ON sunset_policies (tenant_id, enabled);

ALTER TABLE sunset_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE sunset_policies FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sunset_policies_tenant_isolation ON sunset_policies;
CREATE POLICY sunset_policies_tenant_isolation
  ON sunset_policies
  AS PERMISSIVE FOR ALL TO postwave_app
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Execution log: one row per (subscriber, policy, run_id). UNIQUE so
-- a re-run of the same detector pass is idempotent — we never
-- double-suppress or double-tag.

CREATE TABLE IF NOT EXISTS sunset_executions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL,
  policy_id       uuid        NOT NULL REFERENCES sunset_policies(id) ON DELETE CASCADE,
  subscriber_id   uuid        NOT NULL,
  action_taken    text        NOT NULL
                                CHECK (action_taken IN ('suppress','tag','winback','skipped')),
  reason          text,
  executed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_id, subscriber_id)
);

CREATE INDEX IF NOT EXISTS sunset_executions_tenant_executed_idx
  ON sunset_executions (tenant_id, executed_at DESC);

ALTER TABLE sunset_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sunset_executions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sunset_executions_tenant_isolation ON sunset_executions;
CREATE POLICY sunset_executions_tenant_isolation
  ON sunset_executions
  AS PERMISSIVE FOR ALL TO postwave_app
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Re-engagement candidate queue. Action='winback' policies enqueue
-- candidates here; a separate worker (or the customer's automation)
-- drains them into a real "winback" campaign. Decoupling lets the
-- detector stay simple — no template generation, no send pipeline
-- coupling.

CREATE TABLE IF NOT EXISTS winback_candidate_queue (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL,
  policy_id       uuid        NOT NULL REFERENCES sunset_policies(id) ON DELETE CASCADE,
  subscriber_id   uuid        NOT NULL,
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  UNIQUE (policy_id, subscriber_id)
);

CREATE INDEX IF NOT EXISTS winback_queue_unprocessed_idx
  ON winback_candidate_queue (tenant_id, enqueued_at)
  WHERE processed_at IS NULL;

ALTER TABLE winback_candidate_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE winback_candidate_queue FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winback_queue_tenant_isolation ON winback_candidate_queue;
CREATE POLICY winback_queue_tenant_isolation
  ON winback_candidate_queue
  AS PERMISSIVE FOR ALL TO postwave_app
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- updated_at trigger
CREATE OR REPLACE FUNCTION sunset_policies_set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sunset_policies_set_updated_at_trg ON sunset_policies;
CREATE TRIGGER sunset_policies_set_updated_at_trg
  BEFORE UPDATE ON sunset_policies
  FOR EACH ROW EXECUTE FUNCTION sunset_policies_set_updated_at();

COMMIT;
