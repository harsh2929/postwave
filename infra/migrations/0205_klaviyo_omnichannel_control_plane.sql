-- 0205_klaviyo_omnichannel_control_plane.sql
--
-- Klaviyo parity slice KLV-01: one campaign/channel control plane that can
-- represent email, SMS, WhatsApp, RCS, and branded customer-push paths before
-- provider-specific sending is enabled.

BEGIN;

CREATE TABLE omni_campaigns (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                     text NOT NULL,
    status                   text NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft','scheduled','sending','sent','paused','cancelled','archived')),
    objective                text NOT NULL DEFAULT 'marketing'
                             CHECK (objective IN ('marketing','transactional','service','winback','announcement','custom')),
    audience_strategy        jsonb NOT NULL DEFAULT '{}',
    schedule                 jsonb NOT NULL DEFAULT '{}',
    send_strategy            jsonb NOT NULL DEFAULT '{}',
    recipient_snapshot_mode  text NOT NULL DEFAULT 'send_time'
                             CHECK (recipient_snapshot_mode IN ('draft_time','send_time')),
    source_campaign_id       uuid REFERENCES campaigns(id) ON DELETE SET NULL,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX omni_campaigns_tenant_status_idx
    ON omni_campaigns (tenant_id, status, updated_at DESC);

CREATE TRIGGER omni_campaigns_set_updated_at
    BEFORE UPDATE ON omni_campaigns
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON omni_campaigns TO postwave_app;

ALTER TABLE omni_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON omni_campaigns
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON omni_campaigns
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE omni_message_templates (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel             text NOT NULL
                        CHECK (channel IN ('email','sms','whatsapp','rcs','push')),
    name                text NOT NULL,
    status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','ready','approval_required','pending_approval','approved','rejected','archived')),
    subject             text NOT NULL DEFAULT '',
    body_text           text NOT NULL DEFAULT '',
    body_html           text NOT NULL DEFAULT '',
    media               jsonb NOT NULL DEFAULT '{}',
    variables           jsonb NOT NULL DEFAULT '[]',
    provider_template_id text NOT NULL DEFAULT '',
    approval_status     text NOT NULL DEFAULT 'not_required'
                        CHECK (approval_status IN ('not_required','required','pending','approved','rejected','revoked')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, channel, name)
);

CREATE INDEX omni_message_templates_tenant_channel_idx
    ON omni_message_templates (tenant_id, channel, status, updated_at DESC);

CREATE TRIGGER omni_message_templates_set_updated_at
    BEFORE UPDATE ON omni_message_templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON omni_message_templates TO postwave_app;

ALTER TABLE omni_message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_message_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON omni_message_templates
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON omni_message_templates
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE omni_campaign_paths (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id                uuid NOT NULL REFERENCES omni_campaigns(id) ON DELETE CASCADE,
    path_key                   text NOT NULL,
    name                       text NOT NULL,
    channel                    text NOT NULL
                               CHECK (channel IN ('email','sms','whatsapp','rcs','push')),
    status                     text NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft','ready','scheduled','sending','sent','paused','cancelled','blocked')),
    audience                   jsonb NOT NULL DEFAULT '{}',
    message_template_id        uuid REFERENCES omni_message_templates(id) ON DELETE SET NULL,
    fallback_path_key          text NOT NULL DEFAULT '',
    traffic_weight_basis_points integer NOT NULL DEFAULT 10000
                               CHECK (traffic_weight_basis_points >= 0 AND traffic_weight_basis_points <= 10000),
    sequence                   integer NOT NULL DEFAULT 0,
    settings                   jsonb NOT NULL DEFAULT '{}',
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, campaign_id, path_key)
);

CREATE INDEX omni_campaign_paths_campaign_idx
    ON omni_campaign_paths (tenant_id, campaign_id, sequence, path_key);

CREATE TRIGGER omni_campaign_paths_set_updated_at
    BEFORE UPDATE ON omni_campaign_paths
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON omni_campaign_paths TO postwave_app;

ALTER TABLE omni_campaign_paths ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_campaign_paths FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON omni_campaign_paths
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON omni_campaign_paths
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE channel_sender_profiles (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel        text NOT NULL
                   CHECK (channel IN ('email','sms','whatsapp','rcs','push')),
    provider       text NOT NULL DEFAULT 'postwave',
    sender_ref     text NOT NULL DEFAULT '',
    display_name   text NOT NULL DEFAULT '',
    country        text NOT NULL DEFAULT '',
    status         text NOT NULL DEFAULT 'not_configured'
                   CHECK (status IN ('not_configured','draft','pending','ready','rejected','suspended','disabled')),
    capabilities   jsonb NOT NULL DEFAULT '{}',
    limits         jsonb NOT NULL DEFAULT '{}',
    metadata       jsonb NOT NULL DEFAULT '{}',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, channel, provider, sender_ref)
);

CREATE INDEX channel_sender_profiles_tenant_channel_idx
    ON channel_sender_profiles (tenant_id, channel, status);

CREATE TRIGGER channel_sender_profiles_set_updated_at
    BEFORE UPDATE ON channel_sender_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON channel_sender_profiles TO postwave_app;

ALTER TABLE channel_sender_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_sender_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channel_sender_profiles
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON channel_sender_profiles
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE channel_template_approvals (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    template_id         uuid REFERENCES omni_message_templates(id) ON DELETE CASCADE,
    channel             text NOT NULL
                        CHECK (channel IN ('whatsapp','rcs','push','sms','email')),
    provider            text NOT NULL DEFAULT '',
    provider_template_id text NOT NULL DEFAULT '',
    category            text NOT NULL DEFAULT 'marketing',
    language            text NOT NULL DEFAULT 'en',
    status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','submitted','pending','approved','rejected','revoked')),
    variables           jsonb NOT NULL DEFAULT '[]',
    evidence            jsonb NOT NULL DEFAULT '{}',
    rejection_reason    text NOT NULL DEFAULT '',
    submitted_at        timestamptz,
    decided_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX channel_template_approvals_tenant_status_idx
    ON channel_template_approvals (tenant_id, channel, status, updated_at DESC);

CREATE TRIGGER channel_template_approvals_set_updated_at
    BEFORE UPDATE ON channel_template_approvals
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON channel_template_approvals TO postwave_app;

ALTER TABLE channel_template_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_template_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channel_template_approvals
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON channel_template_approvals
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE channel_smart_sending_policies (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            text NOT NULL,
    channel         text NOT NULL
                    CHECK (channel IN ('email','sms','whatsapp','rcs','push','all')),
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('draft','active','paused','archived')),
    window_seconds  integer NOT NULL DEFAULT 57600 CHECK (window_seconds >= 0),
    scope           text NOT NULL DEFAULT 'campaigns_and_flows'
                    CHECK (scope IN ('campaigns','flows','campaigns_and_flows')),
    settings        jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, channel, name)
);

CREATE INDEX channel_smart_sending_policies_tenant_channel_idx
    ON channel_smart_sending_policies (tenant_id, channel, status);

CREATE TRIGGER channel_smart_sending_policies_set_updated_at
    BEFORE UPDATE ON channel_smart_sending_policies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON channel_smart_sending_policies TO postwave_app;

ALTER TABLE channel_smart_sending_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_smart_sending_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channel_smart_sending_policies
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON channel_smart_sending_policies
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE omni_recipients (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id      uuid NOT NULL REFERENCES omni_campaigns(id) ON DELETE CASCADE,
    path_id          uuid REFERENCES omni_campaign_paths(id) ON DELETE SET NULL,
    subscriber_id    uuid,
    email            citext,
    phone_e164       text NOT NULL DEFAULT '',
    push_token       text NOT NULL DEFAULT '',
    channel          text NOT NULL
                     CHECK (channel IN ('email','sms','whatsapp','rcs','push')),
    status           text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','eligible','suppressed','scheduled','sending','sent','delivered','failed','cancelled')),
    scheduled_at     timestamptz,
    sent_at          timestamptz,
    suppressed_reason text NOT NULL DEFAULT '',
    metadata         jsonb NOT NULL DEFAULT '{}',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX omni_recipients_campaign_status_idx
    ON omni_recipients (tenant_id, campaign_id, channel, status, updated_at DESC);

CREATE UNIQUE INDEX omni_recipients_identity_idx
    ON omni_recipients (
        tenant_id,
        campaign_id,
        COALESCE(path_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(subscriber_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(email::text, ''),
        phone_e164,
        push_token
    );

CREATE TRIGGER omni_recipients_set_updated_at
    BEFORE UPDATE ON omni_recipients
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON omni_recipients TO postwave_app;

ALTER TABLE omni_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON omni_recipients
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON omni_recipients
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE channel_send_history (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id         uuid REFERENCES omni_campaigns(id) ON DELETE SET NULL,
    path_id             uuid REFERENCES omni_campaign_paths(id) ON DELETE SET NULL,
    recipient_id        uuid REFERENCES omni_recipients(id) ON DELETE SET NULL,
    message_template_id uuid REFERENCES omni_message_templates(id) ON DELETE SET NULL,
    subscriber_id       uuid,
    email               citext,
    phone_e164          text NOT NULL DEFAULT '',
    push_token          text NOT NULL DEFAULT '',
    channel             text NOT NULL
                        CHECK (channel IN ('email','sms','whatsapp','rcs','push')),
    provider            text NOT NULL DEFAULT '',
    provider_message_id text NOT NULL DEFAULT '',
    status              text NOT NULL DEFAULT 'sent'
                        CHECK (status IN ('suppressed','queued','sent','delivered','opened','clicked','failed','bounced','complained','unsubscribed')),
    suppressed_reason   text NOT NULL DEFAULT '',
    metadata            jsonb NOT NULL DEFAULT '{}',
    sent_at             timestamptz,
    delivered_at        timestamptz,
    opened_at           timestamptz,
    clicked_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX channel_send_history_identity_idx
    ON channel_send_history (tenant_id, channel, COALESCE(email::text, ''), phone_e164, created_at DESC);
CREATE INDEX channel_send_history_campaign_idx
    ON channel_send_history (tenant_id, campaign_id, path_id, status, created_at DESC);

GRANT SELECT, INSERT ON channel_send_history TO postwave_app;

ALTER TABLE channel_send_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_send_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channel_send_history
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON channel_send_history
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
