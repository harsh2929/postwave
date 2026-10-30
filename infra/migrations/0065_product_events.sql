-- 0032_product_events.sql
--
-- Product events ingested via the Loops-style POST /api/v1/track endpoint.
-- Each row is one occurrence of a named event for a subscriber, with an
-- arbitrary JSON properties bag. The automation runtime evaluates triggers
-- of kind "product_event" against this stream.

BEGIN;

CREATE TABLE product_events (
    id               bigserial PRIMARY KEY,
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id    uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    event_name       text NOT NULL,
    properties       jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at      timestamptz NOT NULL DEFAULT now(),
    received_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX product_events_subscriber_idx
    ON product_events (tenant_id, subscriber_id, occurred_at DESC);
CREATE INDEX product_events_tenant_event_idx
    ON product_events (tenant_id, event_name, occurred_at DESC);

GRANT SELECT, INSERT ON product_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE product_events_id_seq TO postwave_app;

ALTER TABLE product_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON product_events
    AS RESTRICTIVE
    FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
