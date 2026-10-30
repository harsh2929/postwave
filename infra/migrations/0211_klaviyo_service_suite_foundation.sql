-- 0211_klaviyo_service_suite_foundation.sql
--
-- Klaviyo parity slice KLV-10: Customer Hub, Helpdesk, and Customer
-- Agent foundations over existing inbound email and SMS conversation sources.

BEGIN;

CREATE TABLE customer_hub_configs (
    tenant_id                uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    status                   text NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft','active','paused','archived')),
    storefronts              jsonb NOT NULL DEFAULT '[]',
    content_blocks           jsonb NOT NULL DEFAULT '[]',
    personalization_rules    jsonb NOT NULL DEFAULT '{}',
    support_settings         jsonb NOT NULL DEFAULT '{}',
    order_history_enabled    boolean NOT NULL DEFAULT true,
    favorites_enabled        boolean NOT NULL DEFAULT true,
    coupons_enabled          boolean NOT NULL DEFAULT true,
    recommendations_enabled  boolean NOT NULL DEFAULT true,
    customer_agent_enabled   boolean NOT NULL DEFAULT false,
    styling                  jsonb NOT NULL DEFAULT '{}',
    metadata                 jsonb NOT NULL DEFAULT '{}',
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER customer_hub_configs_set_updated_at
    BEFORE UPDATE ON customer_hub_configs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_hub_configs TO postwave_app;

ALTER TABLE customer_hub_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_hub_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_hub_configs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON customer_hub_configs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE support_channels (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name           text NOT NULL,
    channel_type   text NOT NULL
                   CHECK (channel_type IN ('web_chat','email','sms','instagram','whatsapp','facebook','generic')),
    status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','active','paused','archived')),
    external_ref   text NOT NULL DEFAULT '',
    routing_rules  jsonb NOT NULL DEFAULT '{}',
    agent_settings jsonb NOT NULL DEFAULT '{}',
    metadata       jsonb NOT NULL DEFAULT '{}',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, channel_type, external_ref)
);

CREATE INDEX support_channels_tenant_status_idx
    ON support_channels (tenant_id, channel_type, status, updated_at DESC);

CREATE TRIGGER support_channels_set_updated_at
    BEFORE UPDATE ON support_channels
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON support_channels TO postwave_app;

ALTER TABLE support_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_channels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_channels
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON support_channels
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE support_conversations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel_id          uuid REFERENCES support_channels(id) ON DELETE SET NULL,
    channel_type        text NOT NULL
                        CHECK (channel_type IN ('web_chat','email','sms','instagram','whatsapp','facebook','generic')),
    source_type         text NOT NULL DEFAULT 'manual'
                        CHECK (source_type IN ('manual','inbound_email','campaign_reply','sms','social','web_chat','whatsapp')),
    external_thread_id  text NOT NULL DEFAULT '',
    subscriber_id       uuid REFERENCES subscribers(id) ON DELETE SET NULL,
    requester_email     citext,
    requester_phone     text NOT NULL DEFAULT '',
    requester_name      text NOT NULL DEFAULT '',
    subject             text NOT NULL DEFAULT '',
    status              text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','pending','waiting','resolved','closed','spam','archived')),
    priority            text NOT NULL DEFAULT 'normal'
                        CHECK (priority IN ('low','normal','high','urgent')),
    assigned_to         text NOT NULL DEFAULT '',
    tags                text[] NOT NULL DEFAULT '{}'::text[],
    last_message_at     timestamptz,
    metadata            jsonb NOT NULL DEFAULT '{}',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX support_conversations_source_unique_idx
    ON support_conversations (tenant_id, source_type, external_thread_id)
    WHERE external_thread_id <> '';
CREATE INDEX support_conversations_tenant_status_idx
    ON support_conversations (tenant_id, status, updated_at DESC);
CREATE INDEX support_conversations_requester_idx
    ON support_conversations (tenant_id, requester_email, requester_phone);

CREATE TRIGGER support_conversations_set_updated_at
    BEFORE UPDATE ON support_conversations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON support_conversations TO postwave_app;

ALTER TABLE support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_conversations
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON support_conversations
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE support_messages (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    conversation_id  uuid NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
    source_type      text NOT NULL DEFAULT 'manual',
    source_id        text NOT NULL DEFAULT '',
    direction        text NOT NULL DEFAULT 'inbound'
                     CHECK (direction IN ('inbound','outbound','internal')),
    sender_type      text NOT NULL DEFAULT 'customer'
                     CHECK (sender_type IN ('customer','agent','system','ai')),
    sender           text NOT NULL DEFAULT '',
    body_text        text NOT NULL DEFAULT '',
    body_html        text NOT NULL DEFAULT '',
    attachments      jsonb NOT NULL DEFAULT '[]',
    metadata         jsonb NOT NULL DEFAULT '{}',
    sent_at          timestamptz NOT NULL DEFAULT now(),
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX support_messages_source_unique_idx
    ON support_messages (tenant_id, source_type, source_id)
    WHERE source_id <> '';
CREATE INDEX support_messages_conversation_idx
    ON support_messages (tenant_id, conversation_id, sent_at ASC);

GRANT SELECT, INSERT, UPDATE, DELETE ON support_messages TO postwave_app;

ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_messages
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON support_messages
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE support_tickets (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    conversation_id   uuid REFERENCES support_conversations(id) ON DELETE SET NULL,
    ticket_number     bigserial,
    title             text NOT NULL,
    status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','pending','waiting','resolved','closed','spam','archived')),
    priority          text NOT NULL DEFAULT 'normal'
                      CHECK (priority IN ('low','normal','high','urgent')),
    assignee          text NOT NULL DEFAULT '',
    source_channel    text NOT NULL DEFAULT 'generic',
    due_at            timestamptz,
    resolved_at       timestamptz,
    metadata          jsonb NOT NULL DEFAULT '{}',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, ticket_number)
);

CREATE INDEX support_tickets_tenant_status_idx
    ON support_tickets (tenant_id, status, priority, updated_at DESC);

CREATE TRIGGER support_tickets_set_updated_at
    BEFORE UPDATE ON support_tickets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON support_tickets TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE support_tickets_ticket_number_seq TO postwave_app;

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_tickets
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON support_tickets
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE support_assignments (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    conversation_id   uuid REFERENCES support_conversations(id) ON DELETE CASCADE,
    ticket_id         uuid REFERENCES support_tickets(id) ON DELETE CASCADE,
    assigned_to       text NOT NULL,
    assigned_by       text NOT NULL DEFAULT '',
    reason            text NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX support_assignments_tenant_recent_idx
    ON support_assignments (tenant_id, created_at DESC);

GRANT SELECT, INSERT, DELETE ON support_assignments TO postwave_app;

ALTER TABLE support_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_assignments
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON support_assignments
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE support_views (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        text NOT NULL,
    visibility  text NOT NULL DEFAULT 'team'
                CHECK (visibility IN ('private','team','system')),
    filters     jsonb NOT NULL DEFAULT '{}',
    sort        jsonb NOT NULL DEFAULT '{}',
    status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','archived')),
    created_by  text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE TRIGGER support_views_set_updated_at
    BEFORE UPDATE ON support_views
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON support_views TO postwave_app;

ALTER TABLE support_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_views FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_views
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON support_views
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE support_macros (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name           text NOT NULL,
    body           text NOT NULL,
    channel_types  text[] NOT NULL DEFAULT '{}'::text[],
    tags           text[] NOT NULL DEFAULT '{}'::text[],
    status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','archived')),
    use_count      integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    last_used_at   timestamptz,
    metadata       jsonb NOT NULL DEFAULT '{}',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX support_macros_use_idx
    ON support_macros (tenant_id, use_count DESC, last_used_at DESC NULLS LAST);

CREATE TRIGGER support_macros_set_updated_at
    BEFORE UPDATE ON support_macros
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON support_macros TO postwave_app;

ALTER TABLE support_macros ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_macros FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_macros
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON support_macros
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE support_spam_assessments (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    conversation_id   uuid REFERENCES support_conversations(id) ON DELETE CASCADE,
    message_id        uuid REFERENCES support_messages(id) ON DELETE CASCADE,
    score             integer NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
    verdict           text NOT NULL DEFAULT 'unknown'
                      CHECK (verdict IN ('unknown','ham','spam','review')),
    signals           jsonb NOT NULL DEFAULT '{}',
    assessed_by       text NOT NULL DEFAULT 'rule',
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX support_spam_assessments_conversation_idx
    ON support_spam_assessments (tenant_id, conversation_id, created_at DESC);

GRANT SELECT, INSERT, DELETE ON support_spam_assessments TO postwave_app;

ALTER TABLE support_spam_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_spam_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_spam_assessments
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON support_spam_assessments
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE support_agent_runs (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    conversation_id   uuid REFERENCES support_conversations(id) ON DELETE SET NULL,
    ticket_id         uuid REFERENCES support_tickets(id) ON DELETE SET NULL,
    run_type          text NOT NULL DEFAULT 'draft_reply'
                      CHECK (run_type IN ('draft_reply','triage','handoff','summary')),
    status            text NOT NULL DEFAULT 'drafted'
                      CHECK (status IN ('drafted','needs_handoff','blocked','accepted','discarded')),
    model             text NOT NULL DEFAULT '',
    prompt            text NOT NULL DEFAULT '',
    draft             text NOT NULL DEFAULT '',
    safety_flags      text[] NOT NULL DEFAULT '{}'::text[],
    handoff_reason    text NOT NULL DEFAULT '',
    tool_plan         jsonb NOT NULL DEFAULT '{}',
    metadata          jsonb NOT NULL DEFAULT '{}',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX support_agent_runs_conversation_idx
    ON support_agent_runs (tenant_id, conversation_id, created_at DESC);

CREATE TRIGGER support_agent_runs_set_updated_at
    BEFORE UPDATE ON support_agent_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON support_agent_runs TO postwave_app;

ALTER TABLE support_agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_agent_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_agent_runs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON support_agent_runs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
