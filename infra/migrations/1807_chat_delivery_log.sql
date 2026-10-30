-- 1807_chat_delivery_log.sql
-- INTG-033 Slice B: durable per-integration delivery history for the chat
-- integrations (Slack / Discord / Teams). The current model overwrites a single
-- last_delivery_* row on each integration, so there is nothing to list. This
-- table records one row per delivery attempt (real events + "Send test") so
-- operators can see a history, not just the last status.
--
-- Polymorphic by (provider, integration_id) — the three providers have separate
-- integration tables, so no FK; rows are cleaned up opportunistically by tenant.

CREATE TABLE IF NOT EXISTS chat_delivery_log (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL,
    provider       text NOT NULL CHECK (provider IN ('slack', 'discord', 'teams')),
    integration_id uuid NOT NULL,
    event_type     text NOT NULL DEFAULT '',
    status         text NOT NULL CHECK (status IN ('success', 'failed')),
    error          text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_delivery_log_lookup_idx
    ON chat_delivery_log (tenant_id, integration_id, created_at DESC);

ALTER TABLE chat_delivery_log ENABLE ROW LEVEL SECURITY;

-- Per-tenant read/write (the ListDeliveries handler + the SendTest path run
-- under the request's tenant scope).
CREATE POLICY tenant_isolation ON chat_delivery_log
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The outbox worker delivers real events under app.outbox_worker scope and
-- appends the log row there, so it needs an INSERT escape.
CREATE POLICY chat_delivery_log_worker_insert ON chat_delivery_log
    FOR INSERT
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON chat_delivery_log TO postwave_app;
