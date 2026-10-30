-- 0345_sto_zero_copy_warehouse_triggers.sql
--
-- sto-zero-copy-warehouse-triggers (Braze Zero-Copy Canvas Triggers parity,
-- P3, XL — next-iteration scaffold).
--
-- Migration 0285 created the base control plane: `external_warehouse_triggers`
-- (definition rows) + `external_warehouse_trigger_fires` (per-row ledger).
-- Migration 0325 relaxed the RLS policy so the cross-tenant worker scan would
-- not be filtered to zero rows.
--
-- This migration scaffolds the next batch of state the worker / control plane
-- need before native Snowflake / BigQuery / Redshift drivers can land:
--
--   1. Alert thresholds + last-alert bookkeeping.
--      Operators need to know *when* a trigger has been failing or lagging.
--      `external_warehouse_trigger_alerts` is a 1:1-with-trigger row that
--      stores the configured thresholds and the last-fired alert state so
--      we do not spam ops with one alert per tick.
--
--   2. Driver health cache columns.
--      The cross-tenant worker today calls `driver.Poll` on every tick.
--      When a connection is dead (creds rotated, warehouse asleep), this
--      wastes a connection slot and burns the connection's quota. The
--      `health_status` / `health_checked_at` / `health_error` columns let
--      a future healthcheck routine cache the outcome so the worker can
--      skip provably-dead triggers between checks.
--
--   3. Dead-letter queue for unresolvable rows.
--      `external_warehouse_trigger_dlq` captures warehouse rows whose
--      profile_key did not resolve to a subscriber AFTER N retries. Today
--      the worker writes a `matched_no_subscriber` fire row and moves on,
--      which loses the row's payload. The DLQ keeps the payload + a
--      retry counter so a human (or a reconciliation job) can replay it
--      once the matching subscriber is created.
--
-- Status: scaffold only. None of the worker / handler code that *uses*
-- these tables has shipped yet — see apps/api/internal/zerocopy_triggers/
-- MIGRATION.md for the deferred items + rough sequencing.

BEGIN;

------------------------------------------------------------------------
-- 1. Alert thresholds + last-fired alert bookkeeping.
------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS external_warehouse_trigger_alerts (
    trigger_id                       uuid PRIMARY KEY
                                     REFERENCES external_warehouse_triggers(id) ON DELETE CASCADE,
    tenant_id                        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- Page ops when the trigger has failed this many consecutive ticks
    -- (matches external_warehouse_triggers.consecutive_failures). 0 == off.
    consecutive_failures_threshold   int  NOT NULL DEFAULT 5
                                     CHECK (consecutive_failures_threshold >= 0
                                            AND consecutive_failures_threshold <= 1000),

    -- Page ops when the trigger has not successfully polled in this many
    -- seconds (last_success_at lag). 0 == off.
    lag_seconds_threshold            int  NOT NULL DEFAULT 900
                                     CHECK (lag_seconds_threshold >= 0
                                            AND lag_seconds_threshold <= 604800),

    -- Page ops when a single tick fires more rows than this number (likely
    -- query regression or backfill mistake). 0 == off.
    fires_per_tick_threshold         int  NOT NULL DEFAULT 0
                                     CHECK (fires_per_tick_threshold >= 0
                                            AND fires_per_tick_threshold <= 1000000),

    -- Webhook URL the alerter posts to. Empty == use the tenant's default
    -- alert channel (resolved at fire-time from the alerts package).
    notify_webhook_url               text NOT NULL DEFAULT '',

    -- Minimum gap between alert posts for the same trigger. Prevents
    -- one tick that crosses three thresholds from generating three pages.
    cooldown_seconds                 int  NOT NULL DEFAULT 1800
                                     CHECK (cooldown_seconds >= 0
                                            AND cooldown_seconds <= 86400),

    -- Last-fired bookkeeping. Used by the alerter to honour cooldown +
    -- to surface "alert pending" in the operator UI.
    last_alert_fired_at              timestamptz,
    last_alert_kind                  text NOT NULL DEFAULT ''
                                     CHECK (last_alert_kind IN ('','failures','lag','fires_burst')),
    last_alert_message               text NOT NULL DEFAULT '',

    created_at                       timestamptz NOT NULL DEFAULT now(),
    updated_at                       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS external_warehouse_trigger_alerts_tenant_idx
    ON external_warehouse_trigger_alerts (tenant_id);

CREATE TRIGGER external_warehouse_trigger_alerts_set_updated_at
    BEFORE UPDATE ON external_warehouse_trigger_alerts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE
    ON external_warehouse_trigger_alerts TO postwave_app;

ALTER TABLE external_warehouse_trigger_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_warehouse_trigger_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_warehouse_trigger_alerts
    AS RESTRICTIVE FOR ALL
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );
CREATE POLICY tenant_visible ON external_warehouse_trigger_alerts
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

COMMENT ON TABLE external_warehouse_trigger_alerts IS
    'Per-trigger alert thresholds + last-fired bookkeeping for Braze Zero-Copy Canvas Triggers parity.';

------------------------------------------------------------------------
-- 2. Driver health cache columns on the base table.
------------------------------------------------------------------------

ALTER TABLE external_warehouse_triggers
    ADD COLUMN IF NOT EXISTS health_status      text        NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS health_checked_at  timestamptz,
    ADD COLUMN IF NOT EXISTS health_error       text        NOT NULL DEFAULT '';

-- Constrain the small set of values the worker should see. We add the
-- constraint NOT VALID and validate so existing rows (all default to
-- 'unknown' from above) don't block the migration.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'external_warehouse_triggers_health_status_chk'
    ) THEN
        ALTER TABLE external_warehouse_triggers
            ADD CONSTRAINT external_warehouse_triggers_health_status_chk
            CHECK (health_status IN ('unknown','healthy','degraded','dead'))
            NOT VALID;
        ALTER TABLE external_warehouse_triggers
            VALIDATE CONSTRAINT external_warehouse_triggers_health_status_chk;
    END IF;
END$$;

-- Partial index for the healthcheck routine: pick triggers whose health
-- has not been re-checked in a while, regardless of status. We don't
-- want a dead-marked trigger to be ignored forever (creds get rotated).
CREATE INDEX IF NOT EXISTS external_warehouse_triggers_health_stale_idx
    ON external_warehouse_triggers (health_checked_at NULLS FIRST)
    WHERE status IN ('active','error');

------------------------------------------------------------------------
-- 3. Dead-letter queue for unresolvable warehouse rows.
------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS external_warehouse_trigger_dlq (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    trigger_id      uuid NOT NULL REFERENCES external_warehouse_triggers(id) ON DELETE CASCADE,

    -- The full warehouse row payload the worker saw. Kept so a
    -- reconciliation pass can re-attempt enrolment once the subscriber
    -- has been created (e.g. signup race vs. warehouse insert).
    cursor_value    text NOT NULL DEFAULT '',
    profile_key     text NOT NULL DEFAULT '',
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- 'unresolved_subscriber' = profile_key did not map to a subscribers row.
    -- 'enqueue_failed'        = the flow_runs insert blew up.
    -- 'driver_partial_row'    = the driver returned a row missing cursor/key.
    reason          text NOT NULL
                    CHECK (reason IN ('unresolved_subscriber','enqueue_failed','driver_partial_row')),

    retry_count     int  NOT NULL DEFAULT 0
                    CHECK (retry_count >= 0 AND retry_count <= 100),
    last_error      text NOT NULL DEFAULT '',
    last_retried_at timestamptz,

    -- 'pending'  = waiting for a retry pass.
    -- 'resolved' = a later retry successfully enqueued a flow_run.
    -- 'abandoned'= retry_count exhausted; operator must intervene.
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','resolved','abandoned')),

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS external_warehouse_trigger_dlq_trigger_idx
    ON external_warehouse_trigger_dlq (trigger_id, created_at DESC);
CREATE INDEX IF NOT EXISTS external_warehouse_trigger_dlq_tenant_status_idx
    ON external_warehouse_trigger_dlq (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS external_warehouse_trigger_dlq_pending_idx
    ON external_warehouse_trigger_dlq (last_retried_at NULLS FIRST)
    WHERE status = 'pending';

CREATE TRIGGER external_warehouse_trigger_dlq_set_updated_at
    BEFORE UPDATE ON external_warehouse_trigger_dlq
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE
    ON external_warehouse_trigger_dlq TO postwave_app;
GRANT USAGE, SELECT
    ON SEQUENCE external_warehouse_trigger_dlq_id_seq TO postwave_app;

ALTER TABLE external_warehouse_trigger_dlq ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_warehouse_trigger_dlq FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_warehouse_trigger_dlq
    AS RESTRICTIVE FOR ALL
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );
CREATE POLICY tenant_visible ON external_warehouse_trigger_dlq
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

COMMENT ON TABLE external_warehouse_trigger_dlq IS
    'Dead-letter queue for warehouse rows that did not enroll into a flow_run. Replayed by a reconciliation routine.';

COMMIT;
