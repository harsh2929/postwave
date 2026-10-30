-- 0098_sms_core.sql
--
-- SMS foundations for the ActiveCampaign replacement roadmap. This creates a
-- channel-native model rather than hiding phone/SMS state inside subscriber
-- JSON fields: sender profiles, registration status, lists/subscriptions,
-- immutable consent events, suppressions, campaigns, messages, and tracked
-- clicks. All tenant-owned tables are RLS-gated on app.tenant_id.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS sms_sender_profiles (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider                   text NOT NULL DEFAULT 'twilio' CHECK (provider IN ('twilio', 'telnyx', 'bandwidth')),
    country                    text NOT NULL DEFAULT 'US' CHECK (country IN ('US', 'CA')),
    sender_type                text NOT NULL DEFAULT '10dlc' CHECK (sender_type IN ('10dlc', 'toll_free', 'short_code')),
    phone_number               text,
    messaging_service_sid      text,
    brand_registration_sid     text,
    campaign_registration_sid  text,
    registration_status        text NOT NULL DEFAULT 'not_started' CHECK (registration_status IN (
                                 'not_started', 'draft', 'pending', 'approved', 'rejected', 'suspended'
                               )),
    capabilities               jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata                   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_sender_profiles_sender_unique
    ON sms_sender_profiles (
        tenant_id,
        provider,
        COALESCE(phone_number, ''),
        COALESCE(messaging_service_sid, '')
    );

CREATE INDEX IF NOT EXISTS sms_sender_profiles_tenant_idx
    ON sms_sender_profiles (tenant_id, registration_status, created_at DESC);

CREATE TABLE IF NOT EXISTS sms_lists (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name               text NOT NULL,
    description        text NOT NULL DEFAULT '',
    keyword            text,
    sender_profile_id  uuid REFERENCES sms_sender_profiles(id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_lists_name_unique
    ON sms_lists (tenant_id, lower(name));

CREATE INDEX IF NOT EXISTS sms_lists_tenant_idx
    ON sms_lists (tenant_id, name);

CREATE TABLE IF NOT EXISTS sms_subscriptions (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    list_id            uuid NOT NULL REFERENCES sms_lists(id) ON DELETE CASCADE,
    phone_e164         text NOT NULL,
    subscriber_email   citext,
    status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'opted_in', 'opted_out')),
    consent_source     text NOT NULL DEFAULT 'unknown' CHECK (consent_source IN ('keyword', 'form', 'import', 'api', 'manual', 'unknown')),
    consent_text       text NOT NULL DEFAULT '',
    consent_at         timestamptz,
    opt_out_at         timestamptz,
    proof              jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, list_id, phone_e164)
);

CREATE INDEX IF NOT EXISTS sms_subscriptions_tenant_phone_idx
    ON sms_subscriptions (tenant_id, phone_e164);
CREATE INDEX IF NOT EXISTS sms_subscriptions_tenant_status_idx
    ON sms_subscriptions (tenant_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS sms_consent_events (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    list_id          uuid REFERENCES sms_lists(id) ON DELETE SET NULL,
    phone_e164       text NOT NULL,
    subscriber_email citext,
    action           text NOT NULL CHECK (action IN ('granted', 'revoked', 'help_requested', 'imported')),
    source           text NOT NULL DEFAULT 'product' CHECK (source IN ('keyword', 'form', 'import', 'api', 'manual', 'twilio', 'product')),
    proof_text       text NOT NULL DEFAULT '',
    provider         text NOT NULL DEFAULT 'twilio',
    provider_event_id text,
    metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sms_consent_events_tenant_phone_idx
    ON sms_consent_events (tenant_id, phone_e164, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS sms_consent_events_provider_unique
    ON sms_consent_events (tenant_id, provider, provider_event_id)
    WHERE provider_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sms_suppressions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    phone_e164      text NOT NULL,
    reason          text NOT NULL CHECK (reason IN ('opt_out', 'manual', 'carrier_complaint', 'invalid_number', 'api')),
    source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('twilio', 'manual', 'api', 'import')),
    source_event_id text,
    expires_at      timestamptz,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, phone_e164)
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_suppressions_source_event_unique
    ON sms_suppressions (tenant_id, source, source_event_id)
    WHERE source_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sms_campaigns (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sender_profile_id  uuid REFERENCES sms_sender_profiles(id) ON DELETE SET NULL,
    list_id            uuid REFERENCES sms_lists(id) ON DELETE SET NULL,
    name               text NOT NULL,
    body               text NOT NULL,
    media_url          text,
    status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'paused', 'failed', 'cancelled')),
    scheduled_at       timestamptz,
    sent_at            timestamptz,
    stats              jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sms_campaigns_tenant_status_idx
    ON sms_campaigns (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS sms_messages (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id         uuid REFERENCES sms_campaigns(id) ON DELETE SET NULL,
    sender_profile_id   uuid REFERENCES sms_sender_profiles(id) ON DELETE SET NULL,
    phone_e164          text NOT NULL,
    provider            text NOT NULL DEFAULT 'twilio',
    provider_message_id text,
    direction           text NOT NULL CHECK (direction IN ('outbound', 'inbound')),
    body                text NOT NULL DEFAULT '',
    media_url           text,
    segments            int NOT NULL DEFAULT 1 CHECK (segments >= 1),
    status              text NOT NULL DEFAULT 'queued' CHECK (status IN (
                          'queued', 'sent', 'delivered', 'failed', 'undelivered', 'received'
                        )),
    error_code          text,
    error_message       text,
    cost_micros         bigint NOT NULL DEFAULT 0,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
    sent_at             timestamptz,
    delivered_at        timestamptz,
    received_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sms_messages_tenant_phone_idx
    ON sms_messages (tenant_id, phone_e164, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS sms_messages_provider_unique
    ON sms_messages (tenant_id, provider, provider_message_id)
    WHERE provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sms_campaign_recipients (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id         uuid NOT NULL REFERENCES sms_campaigns(id) ON DELETE CASCADE,
    sender_profile_id   uuid NOT NULL REFERENCES sms_sender_profiles(id) ON DELETE CASCADE,
    list_id             uuid NOT NULL REFERENCES sms_lists(id) ON DELETE CASCADE,
    phone_e164          text NOT NULL,
    body                text NOT NULL DEFAULT '',
    media_url           text,
    segments            int NOT NULL DEFAULT 1 CHECK (segments >= 1),
    status              text NOT NULL DEFAULT 'queued' CHECK (status IN (
                          'queued', 'sending', 'sent', 'blocked', 'failed', 'cancelled'
                        )),
    gate_reason         text,
    provider            text NOT NULL DEFAULT 'twilio',
    provider_message_id text,
    message_id          uuid REFERENCES sms_messages(id) ON DELETE SET NULL,
    error_code          text,
    error_message       text,
    cost_micros         bigint NOT NULL DEFAULT 0,
    attempts            int NOT NULL DEFAULT 0,
    next_attempt_at     timestamptz NOT NULL DEFAULT now(),
    lease_owner         text,
    leased_until        timestamptz,
    link_tracking       boolean NOT NULL DEFAULT false,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
    sent_at             timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, campaign_id, phone_e164)
);

CREATE INDEX IF NOT EXISTS sms_campaign_recipients_worker_idx
    ON sms_campaign_recipients (status, next_attempt_at, leased_until, created_at);
CREATE INDEX IF NOT EXISTS sms_campaign_recipients_campaign_idx
    ON sms_campaign_recipients (tenant_id, campaign_id, status);

CREATE TABLE IF NOT EXISTS sms_link_clicks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id     uuid REFERENCES sms_campaigns(id) ON DELETE SET NULL,
    message_id      uuid REFERENCES sms_messages(id) ON DELETE SET NULL,
    phone_e164      text NOT NULL,
    url             text NOT NULL,
    clicked_at      timestamptz NOT NULL DEFAULT now(),
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS sms_link_clicks_tenant_campaign_idx
    ON sms_link_clicks (tenant_id, campaign_id, clicked_at DESC);

CREATE TABLE IF NOT EXISTS sms_link_tokens (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id   uuid REFERENCES sms_campaigns(id) ON DELETE CASCADE,
    message_id    uuid REFERENCES sms_messages(id) ON DELETE SET NULL,
    phone_e164    text NOT NULL,
    token         text NOT NULL UNIQUE,
    url           text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sms_link_tokens_tenant_campaign_idx
    ON sms_link_tokens (tenant_id, campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_link_tokens_message_idx
    ON sms_link_tokens (message_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON
    sms_sender_profiles,
    sms_lists,
    sms_subscriptions,
    sms_suppressions,
    sms_campaigns,
    sms_messages,
    sms_campaign_recipients,
    sms_link_clicks,
    sms_link_tokens
TO postwave_app;

GRANT SELECT, INSERT ON sms_consent_events TO postwave_app;

ALTER TABLE sms_sender_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_sender_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE sms_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_lists FORCE ROW LEVEL SECURITY;
ALTER TABLE sms_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE sms_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_consent_events FORCE ROW LEVEL SECURITY;
ALTER TABLE sms_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_suppressions FORCE ROW LEVEL SECURITY;
ALTER TABLE sms_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE sms_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE sms_campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_campaign_recipients FORCE ROW LEVEL SECURITY;
ALTER TABLE sms_link_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_link_clicks FORCE ROW LEVEL SECURITY;
ALTER TABLE sms_link_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_link_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_visible ON sms_sender_profiles
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON sms_lists
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON sms_subscriptions
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON sms_consent_events
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON sms_suppressions
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON sms_campaigns
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON sms_messages
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON sms_campaign_recipients
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON sms_link_clicks
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON sms_link_tokens
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY sms_click_redirect_lookup ON sms_link_tokens
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (current_setting('app.sms_click_redirect', true) = 'true');
CREATE POLICY sms_click_redirect_insert ON sms_link_clicks
    AS PERMISSIVE FOR INSERT TO postwave_app
    WITH CHECK (current_setting('app.sms_click_redirect', true) = 'true');

CREATE POLICY sms_worker_campaigns ON sms_campaigns
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (current_setting('app.sms_worker', true) = 'true')
    WITH CHECK (current_setting('app.sms_worker', true) = 'true');
CREATE POLICY sms_worker_recipients ON sms_campaign_recipients
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (current_setting('app.sms_worker', true) = 'true')
    WITH CHECK (current_setting('app.sms_worker', true) = 'true');
CREATE POLICY sms_worker_messages ON sms_messages
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (current_setting('app.sms_worker', true) = 'true')
    WITH CHECK (current_setting('app.sms_worker', true) = 'true');

COMMIT;
