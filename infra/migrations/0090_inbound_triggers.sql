-- 0090_inbound_triggers.sql
--
-- Drip sequence triggers for inbound webhooks. Each row maps "event
-- arriving on inbound_webhook_endpoints[webhook_id] matching X" to a
-- product action (add subscriber to sequence Y, tag Z, etc).
--
-- Wiring lives in apps/api/internal/inbound_webhooks/triggers.go and
-- is invoked from the receive path AFTER the inbound_events row is
-- persisted, in a goroutine — never blocking the 202 response.

BEGIN;

CREATE TABLE IF NOT EXISTS inbound_webhook_triggers (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The owning inbound webhook endpoint. Note: the table is
    -- inbound_webhook_endpoints (see 0064); the spec calls it
    -- "inbound_webhooks" colloquially but the FK targets the actual
    -- table name in this codebase.
    webhook_id       uuid NOT NULL REFERENCES inbound_webhook_endpoints(id) ON DELETE CASCADE,
    name             text NOT NULL,
    active           boolean NOT NULL DEFAULT true,
    -- JSONPath into the request body for the matching condition.
    -- Examples: "$.event_type", "$.user.email"
    match_jsonpath   text NOT NULL,
    -- equals | contains | exists | regex
    match_operator   text NOT NULL CHECK (match_operator IN
                       ('equals', 'contains', 'exists', 'regex')),
    -- Required for equals/contains/regex; ignored when operator=exists.
    match_value      text,
    -- JSONPath into the request body locating the subscriber email
    -- the action should target.
    email_jsonpath   text NOT NULL,
    -- add_to_sequence | add_tag | remove_tag | start_automation
    action_type      text NOT NULL CHECK (action_type IN
                       ('add_to_sequence', 'add_tag', 'remove_tag', 'start_automation')),
    action_target_id text NOT NULL,
    fired_count      int NOT NULL DEFAULT 0,
    last_fired_at    timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbound_webhook_triggers_tenant_idx
    ON inbound_webhook_triggers (tenant_id);
CREATE INDEX IF NOT EXISTS inbound_webhook_triggers_webhook_active_idx
    ON inbound_webhook_triggers (webhook_id, active);

GRANT SELECT, INSERT, UPDATE, DELETE
    ON inbound_webhook_triggers TO postwave_app;

ALTER TABLE inbound_webhook_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_webhook_triggers FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_visible ON inbound_webhook_triggers
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE TRIGGER inbound_webhook_triggers_set_updated_at
    BEFORE UPDATE ON inbound_webhook_triggers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
