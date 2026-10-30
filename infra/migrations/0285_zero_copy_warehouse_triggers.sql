-- 0285_zero_copy_warehouse_triggers.sql
--
-- sto-zero-copy-warehouse-triggers (Braze parity, P3, XL — scaffold).
--
-- Braze's "Zero-Copy Canvas Triggers" fire journeys directly off a row that
-- lands in the customer's Snowflake / BigQuery / Redshift table. Within
-- seconds of the warehouse INSERT, the matching journey starts; no ETL into
-- our event stream is required.
--
-- This migration scaffolds the data model. A polling worker (see
-- apps/api/internal/zerocopy_triggers/worker.go) reads each definition,
-- issues the configured query against the linked warehouse_connections row
-- (migration 0207), advances last_seen_cursor, and enqueues a flow_run per
-- new row via flowbuilder.EnqueueRun (migration 0229 owns flow_runs).
--
-- Status today: control plane + polling loop scaffold. Real warehouse
-- driver wiring for Snowflake / BigQuery / Redshift is deferred — the
-- current implementation calls into a Driver interface whose only stub
-- impl is "noop" (returns zero rows). Adding native drivers is the next
-- step; the data shape below is what they will read/write.

BEGIN;

CREATE TABLE IF NOT EXISTS external_warehouse_triggers (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Re-uses the existing warehouse_connections control-plane row
    -- (provider + credentials_ref + config). NULL is allowed in the
    -- scaffold so seed rows can exist before a connection is wired.
    connection_id            uuid REFERENCES warehouse_connections(id) ON DELETE SET NULL,
    -- Target journey to enroll into. Resolved against automation_journeys
    -- at fire-time. NULL means "log-only mode" (worker records the run
    -- but does not enqueue) — useful while operators tune the query.
    journey_id               uuid,
    name                     text NOT NULL,
    description              text NOT NULL DEFAULT '',
    status                   text NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft','active','paused','error')),
    -- Provider hint mirrors warehouse_connections.provider so the worker
    -- can route to the right driver without joining on every tick.
    provider                 text NOT NULL DEFAULT 'snowflake'
                             CHECK (provider IN ('snowflake','bigquery','redshift','postgres','noop')),
    -- SQL query the worker runs each tick. Convention: the query must
    -- project columns (cursor_column, profile_key_column, occurred_at,
    -- payload) and accept a `:last_seen_cursor` parameter that the
    -- worker substitutes with the row's current last_seen_cursor.
    query                    text NOT NULL DEFAULT '',
    cursor_column            text NOT NULL DEFAULT 'updated_at',
    profile_key_column       text NOT NULL DEFAULT 'email',
    -- The literal value of the cursor as of the last observed row. The
    -- worker advances this monotonically per tick. Stored as text to
    -- accommodate both timestamptz and monotonic id columns.
    last_seen_cursor         text NOT NULL DEFAULT '',
    polling_interval_seconds int  NOT NULL DEFAULT 60
                             CHECK (polling_interval_seconds BETWEEN 15 AND 86400),
    -- Throttle so a runaway warehouse row burst can't flood flow_runs.
    max_rows_per_tick        int  NOT NULL DEFAULT 500
                             CHECK (max_rows_per_tick BETWEEN 1 AND 10000),
    -- Operational metadata.
    last_polled_at           timestamptz,
    last_success_at          timestamptz,
    last_error               text NOT NULL DEFAULT '',
    consecutive_failures     int  NOT NULL DEFAULT 0,
    rows_fired_total         bigint NOT NULL DEFAULT 0,
    -- Free-form driver-specific config (BigQuery dataset, Redshift
    -- cluster id, etc.). Keeps the table tidy.
    config                   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS external_warehouse_triggers_tenant_status_idx
    ON external_warehouse_triggers (tenant_id, status, last_polled_at NULLS FIRST);

-- The worker fan-out picks up active rows whose last_polled_at is older
-- than the interval. Partial index keeps the planner honest at scale.
CREATE INDEX IF NOT EXISTS external_warehouse_triggers_due_idx
    ON external_warehouse_triggers (last_polled_at NULLS FIRST)
    WHERE status = 'active';

CREATE TRIGGER external_warehouse_triggers_set_updated_at
    BEFORE UPDATE ON external_warehouse_triggers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON external_warehouse_triggers TO postwave_app;

ALTER TABLE external_warehouse_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_warehouse_triggers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_warehouse_triggers
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON external_warehouse_triggers
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Per-row firing ledger. Powers the "show me the last 50 rows this
-- trigger fired off" inspector and lets ops trace a flow_run back to
-- the warehouse row that started it.
CREATE TABLE IF NOT EXISTS external_warehouse_trigger_fires (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL,
    trigger_id      uuid NOT NULL REFERENCES external_warehouse_triggers(id) ON DELETE CASCADE,
    flow_run_id     uuid,
    cursor_value    text NOT NULL DEFAULT '',
    profile_key     text NOT NULL DEFAULT '',
    subscriber_id   uuid,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- 'fired' = a flow_run was enqueued.
    -- 'matched_no_subscriber' = the warehouse row's profile_key did not
    --   resolve to a subscriber (worker still records the cursor so we
    --   don't loop on it).
    -- 'skipped_log_only' = the trigger has journey_id IS NULL.
    -- 'error' = the driver returned a row but enqueue failed.
    status          text NOT NULL DEFAULT 'fired'
                    CHECK (status IN ('fired','matched_no_subscriber','skipped_log_only','error')),
    error           text NOT NULL DEFAULT '',
    fired_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS external_warehouse_trigger_fires_trigger_idx
    ON external_warehouse_trigger_fires (trigger_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS external_warehouse_trigger_fires_tenant_recent_idx
    ON external_warehouse_trigger_fires (tenant_id, fired_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON external_warehouse_trigger_fires TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE external_warehouse_trigger_fires_id_seq TO postwave_app;

ALTER TABLE external_warehouse_trigger_fires ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_warehouse_trigger_fires FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_warehouse_trigger_fires
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON external_warehouse_trigger_fires
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE external_warehouse_triggers IS
    'Braze Zero-Copy Canvas Triggers parity. Each row polls a customer warehouse query and fires a journey per new row, no ETL.';
COMMENT ON TABLE external_warehouse_trigger_fires IS
    'Per-row firing ledger for external_warehouse_triggers — links warehouse rows to flow_runs for ops/traceability.';

COMMIT;
