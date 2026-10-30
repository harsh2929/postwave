-- 0130_audit_sink_dlq.sql
--
-- Dead-letter queue for the audit-sink delivery worker. When a sink
-- delivery fails repeatedly, the failed batch (specifically: the
-- audit_log row range that was being shipped) is captured here so an
-- operator can replay it after fixing the upstream.
--
-- Why a dedicated table rather than a column on audit_sinks:
--
--   * A single sink may have many failed batches outstanding (one per
--     5s tick × hours of downtime). They need to be enumerable.
--   * Replay is per-batch: an operator should be able to retry one
--     batch without disturbing the live cursor.
--   * Cleanup is per-row TTL: successfully replayed rows can drop;
--     audit_sinks.consecutive_failures is just a single int.
--
-- The audit-sink delivery worker (apps/api/internal/auditsink) writes
-- a row here when a delivery fails AFTER reaching the circuit-breaker
-- open state (so we don't flood the DLQ with transient hiccups). The
-- replay worker (or admin CLI) reads pending rows and re-issues the
-- delivery; on success the row is marked replayed_at=now().

BEGIN;

CREATE TABLE IF NOT EXISTS audit_sink_dlq (
    id                bigserial PRIMARY KEY,
    tenant_id         uuid NOT NULL,
    sink_id           uuid NOT NULL,
    -- The audit_log id range this batch was meant to ship. Inclusive
    -- on both ends. The replay worker re-fetches the rows by this
    -- range so the DLQ doesn't need to carry the full payload.
    from_audit_id     bigint NOT NULL,
    to_audit_id       bigint NOT NULL,
    -- Last-error capture from the original delivery attempt. Helps
    -- operators triage ("DNS resolution failed" vs "401 Unauthorized"
    -- vs "Datadog 429 rate limit") without replaying just to see.
    last_error        text NOT NULL,
    attempt_count     int  NOT NULL DEFAULT 1,
    first_failed_at   timestamptz NOT NULL DEFAULT now(),
    last_attempt_at   timestamptz NOT NULL DEFAULT now(),
    -- replayed_at is non-NULL after a successful replay. Rows stay
    -- in the table for the retention window (default 30d) so the
    -- audit trail of "we DID eventually ship this batch" survives.
    replayed_at       timestamptz,
    replayed_by       text,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_sink_dlq_tenant_pending
    ON audit_sink_dlq (tenant_id, sink_id, first_failed_at)
    WHERE replayed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_audit_sink_dlq_sink_pending
    ON audit_sink_dlq (sink_id)
    WHERE replayed_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_sink_dlq TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE audit_sink_dlq_id_seq TO postwave_app;

ALTER TABLE audit_sink_dlq ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON audit_sink_dlq AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Circuit-breaker state. Carries a per-sink state machine the worker
-- consults before issuing a delivery. The state machine:
--
--   closed     → all deliveries pass through (default).
--   open       → all deliveries short-circuit and write to the DLQ
--                without hitting the network. Auto-transitions to
--                half_open when cooldown elapses.
--   half_open  → one probe delivery; on success → closed, on failure
--                → open with extended cooldown.
--
-- The audit_sinks.consecutive_failures column drives the transition
-- closed → open (default threshold: 10). cooldown_until is the
-- earliest moment a half_open probe is allowed.

ALTER TABLE audit_sinks
    ADD COLUMN IF NOT EXISTS circuit_state text NOT NULL DEFAULT 'closed'
        CHECK (circuit_state IN ('closed','open','half_open')),
    ADD COLUMN IF NOT EXISTS cooldown_until timestamptz;

CREATE INDEX IF NOT EXISTS idx_audit_sinks_circuit
    ON audit_sinks (tenant_id, circuit_state)
    WHERE circuit_state != 'closed';

COMMIT;
