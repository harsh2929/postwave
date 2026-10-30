-- 1798_outbound_webhook_operator_notification_outbox.sql
-- rollback-strategy: expand-contract
-- rollback-details: retain the additive outbox; old binaries ignore it.
--
-- Auto-disable is a committed security/reliability transition, so its operator
-- notification must not be a best-effort network call after commit. This
-- tenant-owned outbox is inserted in the same transaction that pauses the
-- endpoint. A leased worker retries delivery without storing recipient
-- addresses, receiver URLs, or credentials in the queue.

CREATE TABLE IF NOT EXISTS outbound_webhook_operator_notifications (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    webhook_id          uuid NOT NULL,
    kind                text NOT NULL,
    status              text NOT NULL DEFAULT 'pending',
    attempts            integer NOT NULL DEFAULT 0,
    next_attempt_at     timestamptz,
    lease_owner         text,
    lease_expires_at    timestamptz,
    last_error          text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    sent_at             timestamptz,
    exhausted_at        timestamptz,
    CONSTRAINT outbound_webhook_operator_notifications_kind_check
        CHECK (kind IN ('auto_disabled')),
    CONSTRAINT outbound_webhook_operator_notifications_status_check
        CHECK (status IN ('pending', 'sending', 'sent', 'exhausted')),
    CONSTRAINT outbound_webhook_operator_notifications_attempts_check
        CHECK (attempts >= 0),
    CONSTRAINT outbound_webhook_operator_notifications_terminal_check
        CHECK (
            (status = 'sent' AND sent_at IS NOT NULL AND exhausted_at IS NULL)
            OR (status = 'exhausted' AND exhausted_at IS NOT NULL AND sent_at IS NULL)
            OR (status IN ('pending', 'sending') AND sent_at IS NULL AND exhausted_at IS NULL)
        )
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
    outbound_webhook_operator_notifications_due_idx
ON outbound_webhook_operator_notifications (
    COALESCE(next_attempt_at, created_at),
    created_at,
    id
)
WHERE status IN ('pending', 'sending');

ALTER TABLE outbound_webhook_operator_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_webhook_operator_notifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbound_webhook_operator_notifications_tenant
    ON outbound_webhook_operator_notifications;
CREATE POLICY outbound_webhook_operator_notifications_tenant
ON outbound_webhook_operator_notifications
FOR ALL
USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
)
WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);

DROP POLICY IF EXISTS outbound_webhook_operator_notifications_worker
    ON outbound_webhook_operator_notifications;
CREATE POLICY outbound_webhook_operator_notifications_worker
ON outbound_webhook_operator_notifications
FOR ALL
USING (current_setting('app.outbox_worker', true) = 'true')
WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE
ON outbound_webhook_operator_notifications
TO postwave_app;

COMMENT ON TABLE outbound_webhook_operator_notifications IS
    'Durable, leased operator notifications for outbound webhook lifecycle transitions; contains no receiver URL or recipient email.';
