-- 0387_agent_routine_runs.sql
--
-- Per-run ledger for agent routines (0386). One row per execution —
-- manual (POST /api/v1/agent-routines/{id}/run) or scheduled. Records
-- the produced draft's reference verbatim (output_kind = 'campaign' |
-- 'sequence', output_ref = the draft's id) plus the pending approval id
-- when the routine's require_approval gate opened one.
--
-- status lifecycle: running → succeeded | failed. There is no
-- 'pending' claim state in v1 — the run row is inserted at execution
-- start, mirroring audience_sync_runs (0377).
--
-- rollback-strategy: no-op - additive table; prior releases never read
-- it, so leaving it in place during a rollback is safe.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_routine_runs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    routine_id  uuid NOT NULL REFERENCES agent_routines(id) ON DELETE CASCADE,
    status      text NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'succeeded', 'failed')),
    -- What the run produced. NULL until the draft lands; recorded
    -- verbatim and never reused as a send target by this surface.
    output_kind text CHECK (output_kind IN ('campaign', 'sequence')),
    output_ref  text,
    -- Pending approvals-row id when the routine gates on approval.
    approval_id text,
    error       text,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS agent_routine_runs_routine_idx
    ON agent_routine_runs (tenant_id, routine_id, started_at DESC);

GRANT SELECT, INSERT, UPDATE ON agent_routine_runs TO postwave_app;

ALTER TABLE agent_routine_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_routine_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON agent_routine_runs
    AS PERMISSIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Worker read gate so cross-tenant ops tooling / the scheduler can
-- inspect run history without binding a tenant. Writes stay
-- tenant-scoped (the runner re-binds app.tenant_id per routine).
CREATE POLICY agent_routine_runs_worker_select ON agent_routine_runs
    AS PERMISSIVE FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
