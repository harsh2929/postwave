-- 0033_inbound_email.sql
--
-- Inbound email parsing — first pass. Per-tenant slug + secret lets us hand
-- ESP inbound webhook payloads (Postmark, SES) a stable URL. Parsed payload
-- rows are written to inbound_emails and an automation trigger of kind
-- "email_reply" is enqueued.

BEGIN;

CREATE TABLE inbound_email_endpoints (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
    slug        text NOT NULL UNIQUE,
    secret      text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE
    ON inbound_email_endpoints TO postwave_app;

ALTER TABLE inbound_email_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_email_endpoints FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON inbound_email_endpoints
    AS RESTRICTIVE
    FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE OR REPLACE FUNCTION inbound_email_endpoint_lookup(p_slug text)
RETURNS TABLE (id uuid, tenant_id uuid, secret text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT id, tenant_id, secret
    FROM inbound_email_endpoints
    WHERE slug = p_slug;
$$;

GRANT EXECUTE ON FUNCTION inbound_email_endpoint_lookup(text) TO postwave_app;

CREATE TABLE inbound_emails (
    id            bigserial PRIMARY KEY,
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id uuid REFERENCES subscribers(id) ON DELETE SET NULL,
    campaign_id   uuid,
    from_email    text NOT NULL,
    to_email      text NOT NULL,
    subject       text NOT NULL DEFAULT '',
    message_id    text,
    in_reply_to   text,
    body_text     text NOT NULL DEFAULT '',
    body_html     text NOT NULL DEFAULT '',
    received_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inbound_emails_tenant_idx
    ON inbound_emails (tenant_id, received_at DESC);
CREATE INDEX inbound_emails_subscriber_idx
    ON inbound_emails (tenant_id, subscriber_id, received_at DESC);
CREATE INDEX inbound_emails_campaign_idx
    ON inbound_emails (tenant_id, campaign_id, received_at DESC);

GRANT SELECT, INSERT ON inbound_emails TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE inbound_emails_id_seq TO postwave_app;

ALTER TABLE inbound_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_emails FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON inbound_emails
    AS RESTRICTIVE
    FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
