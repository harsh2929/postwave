-- 0334_deliverability_hub_tables.sql
--
-- Phase-0 Deliverability Hub contract fix. The hub worker
-- (apps/api/internal/deliverability_hub) already references these
-- tables via INSERT / SELECT, but the schema was never shipped, so the
-- worker fails silently on first tick. This migration creates them
-- with tenant_id, RLS, and the worker-scope policy the existing tick()
-- path expects (see hub.go set_config('app.outbox_worker', 'true', false)).
--
-- Tables:
--
--   deliverability_hub_snapshots  — append-only score history per
--     tenant. Used by /api/v1/deliverability/hub/history (sparkline)
--     and by the down-crossing detector for list_health.degraded
--     webhook emission (only emit on prev>=60 AND now<60). Sampled at
--     the hub-worker cadence (default 1h).
--
--   deliverability_repair_overrides — audit row written when the
--     auto-throttle fires (score<50 sustained), cleared by an admin
--     via POST /api/v1/deliverability/hub/repair-override. The active
--     row (cleared_at IS NULL) is what AutoThrottleActive reads from.

BEGIN;

-- Snapshots: append-only score history per tenant.
CREATE TABLE IF NOT EXISTS deliverability_hub_snapshots (
    id          bigserial   PRIMARY KEY,
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    score       integer     NOT NULL CHECK (score BETWEEN 0 AND 100),
    sampled_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deliverability_hub_snapshots_tenant_sampled_idx
    ON deliverability_hub_snapshots (tenant_id, sampled_at DESC);

GRANT SELECT, INSERT, DELETE ON deliverability_hub_snapshots TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE deliverability_hub_snapshots_id_seq TO postwave_app;

ALTER TABLE deliverability_hub_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliverability_hub_snapshots FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON deliverability_hub_snapshots;
CREATE POLICY tenant_isolation ON deliverability_hub_snapshots
    AS RESTRICTIVE FOR ALL
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

-- Repair overrides: audit + active throttle row.
CREATE TABLE IF NOT EXISTS deliverability_repair_overrides (
    id                            bigserial   PRIMARY KEY,
    tenant_id                     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- prior cap so clearOverride can restore the previous max_sends_per_hour
    -- (NULL means no prior cap was set — restore to NULL).
    prior_max_sends_per_hour      integer,
    -- the cap installed by the throttle (50% of prior_max_sends_per_hour
    -- by default; see AutoThrottleReductionPct).
    throttled_max_sends_per_hour  integer     NOT NULL,
    reason                        text        NOT NULL DEFAULT '',
    created_at                    timestamptz NOT NULL DEFAULT now(),
    cleared_at                    timestamptz,
    cleared_by                    text
);

CREATE INDEX IF NOT EXISTS deliverability_repair_overrides_tenant_active_idx
    ON deliverability_repair_overrides (tenant_id, created_at DESC)
    WHERE cleared_at IS NULL;

CREATE INDEX IF NOT EXISTS deliverability_repair_overrides_tenant_history_idx
    ON deliverability_repair_overrides (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON deliverability_repair_overrides TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE deliverability_repair_overrides_id_seq TO postwave_app;

ALTER TABLE deliverability_repair_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliverability_repair_overrides FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON deliverability_repair_overrides;
CREATE POLICY tenant_isolation ON deliverability_repair_overrides
    AS RESTRICTIVE FOR ALL
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

COMMIT;
