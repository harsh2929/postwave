-- 0225_list_webhooks_scope.sql
--
-- List-scoped outbound webhooks (Mailchimp parity). The existing
-- outbound_webhooks table is tenant-scoped only — every tenant
-- webhook receives every event for the tenant. Mailchimp's list
-- webhooks are scoped to one audience/list: events fire only when
-- a subscriber is added/removed/unsubscribed from THAT list.
--
-- list_id NULL = legacy tenant-wide scope (no behaviour change).
-- list_id set  = receive only list.subscriber.* events whose payload
--                .data.list_id matches this column.
--
-- The dispatcher filter is applied AFTER the existing event-type
-- match in apps/api/internal/outbound_webhooks/dispatcher.go.

BEGIN;

ALTER TABLE outbound_webhooks
    ADD COLUMN IF NOT EXISTS list_id uuid NULL;

CREATE INDEX IF NOT EXISTS outbound_webhooks_tenant_list_idx
    ON outbound_webhooks (tenant_id, list_id)
    WHERE list_id IS NOT NULL;

COMMENT ON COLUMN outbound_webhooks.list_id IS
    'Optional audience/list scope. When set, dispatcher fires only the '
    'list.subscriber.* event types whose payload list_id matches.';

COMMIT;
