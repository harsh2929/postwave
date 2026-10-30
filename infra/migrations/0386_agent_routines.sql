-- 0386_agent_routines.sql
--
-- Agent routines (platform-2026 roadmap, "Agent routines with approval
-- gates"): a tenant-authored standing instruction the platform's agent
-- executes on a schedule — "every Monday draft a re-engagement campaign
-- for the lapsed segment". Each routine names a draft kind
-- (draft_campaign | draft_sequence), a free-text prompt/brief that is
-- fed to the voice service's existing drafting endpoints, optional
-- audience hints, and an approval flag.
--
-- SAFETY INVARIANT: routines only ever produce DRAFT artifacts
-- (campaigns.status = 'draft', voice sequences status = 'draft').
-- Nothing in this surface can queue or send. When require_approval is
-- true (the default — deliberately) every run additionally opens a
-- pending row in the approvals table (0023) referencing the draft, so
-- the human-in-the-loop gate sees agent output before anyone promotes
-- it.
--
-- schedule_detail is a jsonb hint bag (e.g. {"hour_utc": 9,
-- "weekday": 1}) reserved for finer-grained scheduling; the v1
-- scheduler is interval-based (daily/weekly/monthly measured from
-- last_run_at), mirroring audience_syncs (0376).
--
-- target_list_id / target_segment_id are *hints* surfaced to the LLM
-- prompt and stamped onto draft campaigns (segment only — campaigns
-- carry no list column); they are optional and may both be NULL.
--
-- rollback-strategy: no-op - additive table; prior releases never read
-- it, so leaving it in place during a rollback is safe.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_routines (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    -- The standing brief handed to the drafting LLM verbatim. Bounded
    -- well below the request body cap so a pasted document can't blow
    -- the prompt budget (mirrors the voice service's draft brief cap).
    prompt            text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 8000),
    kind              text NOT NULL
                      CHECK (kind IN ('draft_campaign', 'draft_sequence')),
    schedule          text NOT NULL DEFAULT 'manual'
                      CHECK (schedule IN ('manual', 'daily', 'weekly', 'monthly')),
    schedule_detail   jsonb NOT NULL DEFAULT '{}'::jsonb,
    target_list_id    uuid,
    target_segment_id uuid REFERENCES segments(id) ON DELETE SET NULL,
    -- DEFAULT TRUE is load-bearing: agent output is gated by a human
    -- unless the operator explicitly opts a routine out.
    require_approval  boolean NOT NULL DEFAULT true,
    enabled           boolean NOT NULL DEFAULT true,
    last_run_at       timestamptz,
    created_by        text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS agent_routines_tenant_idx
    ON agent_routines (tenant_id, created_at DESC);

-- Scheduler tick: "which enabled, scheduled routines are due?".
-- Partial so manual-only tenants cost nothing (0376 pattern).
CREATE INDEX IF NOT EXISTS agent_routines_due_idx
    ON agent_routines (schedule, last_run_at)
    WHERE enabled AND schedule <> 'manual';

CREATE TRIGGER agent_routines_set_updated_at
    BEFORE UPDATE ON agent_routines
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_routines TO postwave_app;

ALTER TABLE agent_routines ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_routines FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON agent_routines
    AS PERMISSIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Scheduler enumeration (cross-tenant SELECT under db.WithWorkerScope,
-- mirroring audience_syncs_worker_select from 0376). The worker
-- re-binds app.tenant_id per routine before executing, so all writes
-- (run rows, last_run_at, draft campaigns) go through tenant_isolation.
CREATE POLICY agent_routines_worker_select ON agent_routines
    AS PERMISSIVE FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
