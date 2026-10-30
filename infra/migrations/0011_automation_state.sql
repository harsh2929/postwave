-- 0011_automation_state.sql
--
-- Durable state for the automation runtime. Replaces the in-process
-- MemoryStore in services/automation/internal/runtime so that executions
-- survive process restarts and Asynq workers can resume mid-flow.
--
-- The exec id is deterministic — sha256(tenant_id || automation_id ||
-- subscriber_email) — so duplicate triggers become idempotent UPSERTs.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE automation_executions (
    id                text PRIMARY KEY,
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    automation_id     uuid NOT NULL,
    subscriber_email  citext NOT NULL,
    current_node      text,
    completed_nodes   text[] NOT NULL DEFAULT '{}',
    started_at        timestamptz NOT NULL DEFAULT now(),
    last_at           timestamptz NOT NULL DEFAULT now(),
    paused            boolean NOT NULL DEFAULT false,
    error             text
);

CREATE INDEX automation_executions_tenant_idx
    ON automation_executions (tenant_id, automation_id, last_at DESC);
CREATE INDEX automation_executions_paused_idx
    ON automation_executions (automation_id, paused);
CREATE UNIQUE INDEX automation_executions_lookup_idx
    ON automation_executions (automation_id, subscriber_email);

GRANT SELECT, INSERT, UPDATE, DELETE ON automation_executions TO postwave_app;

ALTER TABLE automation_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_executions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_executions
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Per-automation pause flag. Stored separately so SetPaused does not need to
-- enumerate all execution rows. Platform-internal, no RLS — the API gateway
-- enforces tenant scope when reading/writing.
CREATE TABLE automation_paused (
    automation_id uuid PRIMARY KEY,
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    paused        boolean NOT NULL DEFAULT false,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX automation_paused_tenant_idx ON automation_paused (tenant_id);

CREATE TRIGGER automation_paused_set_updated_at
    BEFORE UPDATE ON automation_paused
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON automation_paused TO postwave_app;

ALTER TABLE automation_paused ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_paused FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_paused
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
