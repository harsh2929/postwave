-- 1403_approval_chain.sql
--
-- G20 (campaigns 2026): multi-stage (N-stage) ordered approval chain.
-- The existing approvals system is a single gate (one approve/reject
-- consumes the approval). This adds a tenant-defined ordered chain of
-- roles (e.g. Editor -> Legal -> CMO): each stage must approve before
-- the next is notified, the resource unlocks only after the FINAL stage
-- approves, and any stage reject terminates the chain. The single-gate
-- two-person / delegation / escalation features are untouched.

BEGIN;

-- Per-tenant chain definition: ordered roles for a resource type.
CREATE TABLE IF NOT EXISTS approval_chain_steps (
    id            bigserial   PRIMARY KEY,
    tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    resource_type text        NOT NULL,
    position      integer     NOT NULL,            -- 1-based stage order
    role          text        NOT NULL,            -- e.g. 'editor','legal','cmo'
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, resource_type, position)
);

-- Per-approval stage progress: one row per stage, advanced as decisions land.
CREATE TABLE IF NOT EXISTS approval_chain_progress (
    id                 bigserial   PRIMARY KEY,
    tenant_id          uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    approval_id        uuid        NOT NULL,
    position           integer     NOT NULL,
    role               text        NOT NULL,
    status             text        NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
    decided_by_user_id text,
    decided_at         timestamptz,
    UNIQUE (tenant_id, approval_id, position)
);

CREATE INDEX IF NOT EXISTS approval_chain_progress_lookup_idx
    ON approval_chain_progress (tenant_id, approval_id, position);

GRANT SELECT, INSERT, UPDATE, DELETE ON approval_chain_steps TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_chain_progress TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE approval_chain_steps_id_seq TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE approval_chain_progress_id_seq TO postwave_app;

ALTER TABLE approval_chain_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_chain_steps FORCE  ROW LEVEL SECURITY;
ALTER TABLE approval_chain_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_chain_progress FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON approval_chain_steps
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON approval_chain_steps
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON approval_chain_progress
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON approval_chain_progress
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
