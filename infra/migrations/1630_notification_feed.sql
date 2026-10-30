-- 1630_notification_feed.sql
--
-- Server-backed per-user in-app notification feed (the "bell" inbox) with
-- seen/read state. Distinct from notification_preferences (which gates
-- outbound customer-facing email) and from web/desktop push: this is the
-- operator's own in-product activity inbox (approval requested, billing
-- alert, export ready, ...).
--
-- RLS is tenant-scoped (every row carries tenant_id); per-USER visibility is
-- enforced by the handlers (they always filter user_id = the acting session
-- user). A worker-scope escape lets a fanout writer running under
-- app.outbox_worker insert rows when it already knows the tenant.

BEGIN;

CREATE TABLE IF NOT EXISTS notification_feed (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Recipient (users.id). No FK so a user delete doesn't cascade-wipe their
    -- historical feed; tenant cascade above is enough.
    user_id     uuid NOT NULL,
    -- Machine kind for client routing/icons, e.g. 'approval_request',
    -- 'billing_alert', 'export_ready', 'audit_alert'.
    kind        text NOT NULL,
    title       text NOT NULL,
    body        text NOT NULL DEFAULT '',
    -- In-app route to open on click, e.g. '/app/approvals/123'.
    deep_link   text NOT NULL DEFAULT '',
    payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- seen_at: surfaced in the bell (clears the unseen badge).
    -- read_at: explicitly opened/acknowledged.
    seen_at     timestamptz,
    read_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_feed_user_recent_idx
    ON notification_feed (tenant_id, user_id, created_at DESC);
-- Hot path: the unseen-count badge.
CREATE INDEX IF NOT EXISTS notification_feed_unseen_idx
    ON notification_feed (tenant_id, user_id) WHERE seen_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_feed TO postwave_app;

ALTER TABLE notification_feed ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_feed FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON notification_feed
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY tenant_visible ON notification_feed
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

COMMIT;
