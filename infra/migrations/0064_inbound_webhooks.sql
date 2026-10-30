-- 0031_inbound_webhooks.sql
--
-- Inbound webhook endpoints (the inverse of webhooks): per-tenant slugs that
-- accept POSTed events from upstream systems. Signed via HMAC-SHA256 of the
-- raw body keyed by the per-endpoint secret. Validated requests are landed
-- in inbound_events and an automation trigger of kind "inbound_webhook" is
-- enqueued.

BEGIN;

CREATE TABLE inbound_webhook_endpoints (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    slug        text NOT NULL UNIQUE,
    secret      text NOT NULL,
    name        text NOT NULL DEFAULT '',
    enabled     boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inbound_webhook_endpoints_tenant_idx
    ON inbound_webhook_endpoints (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE
    ON inbound_webhook_endpoints TO postwave_app;

ALTER TABLE inbound_webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_webhook_endpoints FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON inbound_webhook_endpoints
    AS RESTRICTIVE
    FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The public ingest endpoint must look up an endpoint by slug WITHOUT a
-- tenant context. We add a permissive bypass policy for an `inbound_writer`
-- role; for V1 we let the gateway use a slug-keyed lookup against the
-- non-RLS-protected unique index by issuing the query as a privileged
-- session on the same role; for now the slug lookup is performed via a
-- function that runs SECURITY DEFINER. Keep RLS on the user-facing path.

CREATE OR REPLACE FUNCTION inbound_webhook_lookup(p_slug text)
RETURNS TABLE (id uuid, tenant_id uuid, secret text, enabled boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT id, tenant_id, secret, enabled
    FROM inbound_webhook_endpoints
    WHERE slug = p_slug;
$$;

GRANT EXECUTE ON FUNCTION inbound_webhook_lookup(text) TO postwave_app;

CREATE TABLE inbound_events (
    id               bigserial PRIMARY KEY,
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    endpoint_id      uuid NOT NULL REFERENCES inbound_webhook_endpoints(id) ON DELETE CASCADE,
    headers          jsonb NOT NULL DEFAULT '{}'::jsonb,
    body_bytes       bytea NOT NULL,
    signature_valid  boolean NOT NULL,
    received_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inbound_events_tenant_idx
    ON inbound_events (tenant_id, received_at DESC);
CREATE INDEX inbound_events_endpoint_idx
    ON inbound_events (endpoint_id, received_at DESC);

GRANT SELECT, INSERT ON inbound_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE inbound_events_id_seq TO postwave_app;

ALTER TABLE inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON inbound_events
    AS RESTRICTIVE
    FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
