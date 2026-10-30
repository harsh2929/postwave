-- 0229_flow_runs.sql
--
-- Workstream 3: source-event → flow fan-out. When a product event arrives the
-- track ingest enqueues a flow_runs row for every active flow whose
-- product_event trigger matches the event name. The downstream automation
-- runtime drains this queue; the rest of the API only writes here.
--
-- The row is intentionally thin — it points at flow + subscriber + the source
-- event id, with lifecycle timestamps. Run-specific state (current node,
-- waiting timers, etc.) lives in automation_journey_executions which the
-- automation service owns; this table is the durable hand-off log.

BEGIN;

CREATE TABLE flow_runs (
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    flow_id           uuid NOT NULL REFERENCES automation_journeys(id) ON DELETE CASCADE,
    subscriber_id     uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    trigger_event_id  bigint,
    trigger_event_name text,
    status            text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    scheduled_at      timestamptz NOT NULL DEFAULT now(),
    started_at        timestamptz,
    finished_at       timestamptz,
    error             text,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX flow_runs_tenant_status_idx
    ON flow_runs (tenant_id, status, scheduled_at);

CREATE INDEX flow_runs_tenant_flow_idx
    ON flow_runs (tenant_id, flow_id, created_at DESC);

CREATE INDEX flow_runs_tenant_subscriber_idx
    ON flow_runs (tenant_id, subscriber_id, created_at DESC);

CREATE INDEX flow_runs_trigger_event_idx
    ON flow_runs (tenant_id, trigger_event_id)
    WHERE trigger_event_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON flow_runs TO postwave_app;

ALTER TABLE flow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON flow_runs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON flow_runs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
