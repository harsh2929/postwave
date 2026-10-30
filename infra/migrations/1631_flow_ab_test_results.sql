-- 1631_flow_ab_test_results.sql
--
-- Per-variant outcome tracking for in-flow A/B tests. automation_flow_ab_tests
-- (migration 0202) stores the test CONFIG (variants + winner) per node; these
-- two tables capture what actually happened so a winner can be derived:
--
--   flow_ab_test_assignments — one row per (tenant, automation, node, subscriber):
--     which variant a subscriber was deterministically bucketed into, and when
--     (if ever) they converted. Drives per-variant conversion attribution and
--     guarantees a subscriber is counted once (earliest-wins).
--
--   flow_ab_test_results — rolling per-variant counters (assigned / converted),
--     keyed by (tenant, automation, node, variant). The automation engine
--     increments assigned on assignment and converted on goal-met; the winner
--     evaluator reads these aggregates.
--
-- Written by the automation runtime under per-tenant scope (app.tenant_id), so
-- standard tenant RLS — no worker-scope escape needed.

BEGIN;

CREATE TABLE IF NOT EXISTS flow_ab_test_assignments (
    id               bigserial PRIMARY KEY,
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    automation_id    uuid NOT NULL,
    node_id          text NOT NULL,
    subscriber_email citext NOT NULL,
    variant_id       text NOT NULL,
    assigned_at      timestamptz NOT NULL DEFAULT now(),
    converted_at     timestamptz,
    UNIQUE (tenant_id, automation_id, node_id, subscriber_email)
);

CREATE INDEX IF NOT EXISTS flow_ab_test_assignments_lookup_idx
    ON flow_ab_test_assignments (tenant_id, automation_id, subscriber_email)
    WHERE converted_at IS NULL;

CREATE TABLE IF NOT EXISTS flow_ab_test_results (
    id            bigserial PRIMARY KEY,
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    automation_id uuid NOT NULL,
    node_id       text NOT NULL,
    variant_id    text NOT NULL,
    assigned      integer NOT NULL DEFAULT 0,
    converted     integer NOT NULL DEFAULT 0,
    occurred_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, automation_id, node_id, variant_id)
);

GRANT SELECT, INSERT, UPDATE ON flow_ab_test_assignments TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE flow_ab_test_assignments_id_seq TO postwave_app;
GRANT SELECT, INSERT, UPDATE ON flow_ab_test_results TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE flow_ab_test_results_id_seq TO postwave_app;

ALTER TABLE flow_ab_test_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_ab_test_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE flow_ab_test_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_ab_test_results FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON flow_ab_test_assignments
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON flow_ab_test_assignments
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON flow_ab_test_results
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON flow_ab_test_results
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
