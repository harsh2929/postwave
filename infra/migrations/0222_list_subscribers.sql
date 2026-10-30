-- 0222_list_subscribers.sql
--
-- Durable local list membership join table for bulk subscriber move-to-list.
-- The first-party lists API proxies Listmonk, so list metadata can live
-- upstream; this table records Postwave-side subscriber membership by UUID
-- list id for bulk operations, segments, and future migration materializers.

BEGIN;

CREATE TABLE list_subscribers (
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    list_id       uuid NOT NULL,
    subscriber_id uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    added_at      timestamptz NOT NULL DEFAULT now(),
    metadata      jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY (tenant_id, list_id, subscriber_id),
    UNIQUE (list_id, subscriber_id)
);

CREATE INDEX list_subscribers_tenant_list_idx
    ON list_subscribers (tenant_id, list_id, added_at DESC);

CREATE INDEX list_subscribers_tenant_subscriber_idx
    ON list_subscribers (tenant_id, subscriber_id, added_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON list_subscribers TO postwave_app;

ALTER TABLE list_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_subscribers FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON list_subscribers
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON list_subscribers
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
