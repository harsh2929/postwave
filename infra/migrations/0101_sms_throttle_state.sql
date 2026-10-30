-- 0101_sms_throttle_state.sql
--
-- Distributed SMS throughput and provider backoff state. Workers use this
-- table to lease per-sender send slots across processes, pause hot senders
-- after carrier/provider throttles, and keep queued recipients out of tight
-- retry loops.

BEGIN;

CREATE TABLE IF NOT EXISTS sms_send_throttle_state (
    tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sender_profile_id      uuid NOT NULL REFERENCES sms_sender_profiles(id) ON DELETE CASCADE,
    provider               text NOT NULL,
    next_available_at      timestamptz NOT NULL DEFAULT now(),
    suspended_until        timestamptz,
    consecutive_failures   int NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    last_error_code        text,
    last_error_message     text,
    last_success_at        timestamptz,
    last_failure_at        timestamptz,
    updated_at             timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, sender_profile_id)
);

CREATE INDEX IF NOT EXISTS sms_send_throttle_state_due_idx
    ON sms_send_throttle_state (tenant_id, provider, next_available_at, suspended_until);

GRANT SELECT, INSERT, UPDATE, DELETE ON sms_send_throttle_state TO postwave_app;

ALTER TABLE sms_send_throttle_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_send_throttle_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_visible ON sms_send_throttle_state;
CREATE POLICY tenant_visible ON sms_send_throttle_state
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
