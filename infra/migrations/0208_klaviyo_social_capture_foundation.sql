-- 0208_klaviyo_social_capture_foundation.sql
--
-- Klaviyo parity slice KLV-02: social auto-reply lead capture and
-- tap-to-text opt-in foundations on top of SMS consent/list primitives.

BEGIN;

CREATE TABLE social_auto_reply_rules (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                text NOT NULL,
    network             text NOT NULL DEFAULT 'instagram'
                        CHECK (network IN ('instagram','facebook','tiktok','generic')),
    status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','active','paused','archived')),
    trigger_phrases     text[] NOT NULL DEFAULT '{}'::text[],
    questions           jsonb NOT NULL DEFAULT '[]',
    property_mappings   jsonb NOT NULL DEFAULT '{}',
    target_list_id      uuid,
    target_segment_id   uuid,
    sms_list_id         uuid REFERENCES sms_lists(id) ON DELETE SET NULL,
    sender_profile_id   uuid REFERENCES sms_sender_profiles(id) ON DELETE SET NULL,
    reply_template      text NOT NULL DEFAULT '',
    consent_handoff     jsonb NOT NULL DEFAULT '{}',
    metadata            jsonb NOT NULL DEFAULT '{}',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX social_auto_reply_rules_tenant_status_idx
    ON social_auto_reply_rules (tenant_id, network, status, updated_at DESC);

CREATE TRIGGER social_auto_reply_rules_set_updated_at
    BEFORE UPDATE ON social_auto_reply_rules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON social_auto_reply_rules TO postwave_app;

ALTER TABLE social_auto_reply_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_auto_reply_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON social_auto_reply_rules
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON social_auto_reply_rules
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE social_lead_captures (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    rule_id             uuid REFERENCES social_auto_reply_rules(id) ON DELETE SET NULL,
    network             text NOT NULL DEFAULT 'instagram',
    external_user_id    text NOT NULL DEFAULT '',
    external_thread_id  text NOT NULL DEFAULT '',
    subscriber_email    citext,
    phone_e164          text NOT NULL DEFAULT '',
    answers             jsonb NOT NULL DEFAULT '{}',
    mapped_properties   jsonb NOT NULL DEFAULT '{}',
    status              text NOT NULL DEFAULT 'captured'
                        CHECK (status IN ('captured','consent_pending','consent_granted','ignored')),
    metadata            jsonb NOT NULL DEFAULT '{}',
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX social_lead_captures_tenant_recent_idx
    ON social_lead_captures (tenant_id, created_at DESC);
CREATE INDEX social_lead_captures_external_idx
    ON social_lead_captures (tenant_id, network, external_thread_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON social_lead_captures TO postwave_app;

ALTER TABLE social_lead_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_lead_captures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON social_lead_captures
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON social_lead_captures
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE tap_to_text_links (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    slug                citext NOT NULL,
    name                text NOT NULL,
    status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','active','paused','archived')),
    sms_list_id         uuid REFERENCES sms_lists(id) ON DELETE SET NULL,
    sender_profile_id   uuid REFERENCES sms_sender_profiles(id) ON DELETE SET NULL,
    destination_phone   text NOT NULL DEFAULT '',
    keyword             text NOT NULL DEFAULT 'START',
    message_body        text NOT NULL DEFAULT '',
    consent_text        text NOT NULL DEFAULT '',
    success_url         text NOT NULL DEFAULT '',
    proof_metadata      jsonb NOT NULL DEFAULT '{}',
    stats               jsonb NOT NULL DEFAULT '{}',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, slug)
);

CREATE INDEX tap_to_text_links_tenant_status_idx
    ON tap_to_text_links (tenant_id, status, updated_at DESC);
CREATE INDEX tap_to_text_links_public_slug_idx
    ON tap_to_text_links (slug) WHERE status = 'active';

CREATE TRIGGER tap_to_text_links_set_updated_at
    BEFORE UPDATE ON tap_to_text_links
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON tap_to_text_links TO postwave_app;

ALTER TABLE tap_to_text_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE tap_to_text_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tap_to_text_links
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            status = 'active'
            AND slug = NULLIF(current_setting('app.public_tap_to_text_slug', true), '')::citext
        )
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON tap_to_text_links
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY public_active_tap_to_text ON tap_to_text_links
    AS PERMISSIVE FOR SELECT
    TO postwave_app
    USING (status = 'active' AND slug = NULLIF(current_setting('app.public_tap_to_text_slug', true), '')::citext);

CREATE TABLE tap_to_text_events (
    id                  bigserial PRIMARY KEY,
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    link_id             uuid REFERENCES tap_to_text_links(id) ON DELETE SET NULL,
    event_type          text NOT NULL CHECK (event_type IN ('view','click','consent')),
    phone_e164          text NOT NULL DEFAULT '',
    subscriber_email    citext,
    metadata            jsonb NOT NULL DEFAULT '{}',
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tap_to_text_events_link_idx
    ON tap_to_text_events (tenant_id, link_id, event_type, created_at DESC);

GRANT SELECT, INSERT, DELETE ON tap_to_text_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE tap_to_text_events_id_seq TO postwave_app;

ALTER TABLE tap_to_text_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tap_to_text_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tap_to_text_events
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON tap_to_text_events
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
