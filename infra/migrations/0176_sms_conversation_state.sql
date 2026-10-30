-- 0176_sms_conversation_state.sql
--
-- Per-conversation read marker for the SMS inbox. One row per
-- (tenant_id, phone_e164) tracking when the operator last marked
-- the thread read. The inbox's unread count = inbound messages
-- whose created_at > read_at.
--
-- Kept on a separate table (rather than denormalised onto
-- sms_messages or sms_subscriptions) because:
--
--   * sms_subscriptions models subscribers; not every conversation
--     has a subscription row (a STOP from a wrong number still
--     creates an inbound message but no subscription).
--   * Denormalising onto sms_messages would write-amp every send
--     just to update a per-conversation flag.
--   * A side-table lets us add per-conversation operator metadata
--     later (assigned_to, snoozed_until, tags) without further
--     migrations.

BEGIN;

CREATE TABLE IF NOT EXISTS sms_conversation_state (
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    phone_e164  text        NOT NULL,
    read_at     timestamptz,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, phone_e164)
);

ALTER TABLE sms_conversation_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY sms_conversation_state_tenant_isolation
    ON sms_conversation_state
    FOR ALL
    USING (tenant_id::text = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON sms_conversation_state TO postwave_app;

COMMIT;
