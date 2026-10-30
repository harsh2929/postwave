-- 0030_mailchimp_productization.sql
--
-- Production hardening for the Mailchimp-compatibility surfaces:
-- deduped provider events, suppression controls, public popup rendering,
-- ecommerce OAuth/webhook state, basic automation-journey execution state,
-- and tenant plan usage snapshots.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Engagement ingestion + suppression controls
-- ---------------------------------------------------------------------------
ALTER TABLE subscriber_events
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'listmonk',
    ADD COLUMN IF NOT EXISTS provider_event_id text,
    ADD COLUMN IF NOT EXISTS message_id text,
    ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS subscriber_events_provider_event_unique
    ON subscriber_events (tenant_id, source, provider_event_id)
    WHERE provider_event_id IS NOT NULL;

ALTER TABLE campaign_report_events
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS provider_event_id text,
    ADD COLUMN IF NOT EXISTS message_id text;

CREATE UNIQUE INDEX IF NOT EXISTS campaign_report_events_provider_event_unique
    ON campaign_report_events (tenant_id, source, provider_event_id)
    WHERE provider_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_suppressions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email             citext NOT NULL,
    reason            text NOT NULL CHECK (reason IN (
        'hard_bounce', 'complaint', 'unsubscribe', 'manual', 'imported'
    )),
    source            text NOT NULL DEFAULT 'system',
    provider_event_id text,
    campaign_id       uuid,
    metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
    suppressed_at     timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email, reason)
);

CREATE INDEX IF NOT EXISTS email_suppressions_tenant_email_idx
    ON email_suppressions (tenant_id, email);
CREATE INDEX IF NOT EXISTS email_suppressions_active_idx
    ON email_suppressions (tenant_id, reason, suppressed_at DESC)
    WHERE expires_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON email_suppressions TO postwave_app;

ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_suppressions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON email_suppressions;
CREATE POLICY tenant_isolation ON email_suppressions
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Public popup embed lookup
-- ---------------------------------------------------------------------------
ALTER TABLE popup_forms
    ADD COLUMN IF NOT EXISTS public_key text;

UPDATE popup_forms
   SET public_key = lower(substr(replace(id::text, '-', ''), 1, 16))
 WHERE public_key IS NULL;

ALTER TABLE popup_forms
    ALTER COLUMN public_key SET DEFAULT lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));

CREATE UNIQUE INDEX IF NOT EXISTS popup_forms_public_key_unique
    ON popup_forms (public_key);
CREATE INDEX IF NOT EXISTS popup_forms_published_public_idx
    ON popup_forms (public_key)
    WHERE status = 'published';

DROP POLICY IF EXISTS popup_forms_public_lookup ON popup_forms;
CREATE POLICY popup_forms_public_lookup ON popup_forms
    FOR SELECT
    USING (
        status = 'published'
        AND public_key = NULLIF(current_setting('app.public_popup_key', true), '')
    );

-- ---------------------------------------------------------------------------
-- Commerce OAuth + webhook dedupe
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_oauth_states (
    state       text PRIMARY KEY,
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider     text NOT NULL CHECK (provider IN ('shopify', 'woocommerce', 'stripe', 'square')),
    shop_domain  text,
    scopes       text[] NOT NULL DEFAULT '{}'::text[],
    redirect_uri text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
    used_at      timestamptz
);

CREATE INDEX IF NOT EXISTS commerce_oauth_states_tenant_idx
    ON commerce_oauth_states (tenant_id, provider, created_at DESC);
CREATE INDEX IF NOT EXISTS commerce_oauth_states_expiry_idx
    ON commerce_oauth_states (expires_at)
    WHERE used_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_oauth_states TO postwave_app;

ALTER TABLE commerce_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_oauth_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commerce_oauth_states;
CREATE POLICY tenant_isolation ON commerce_oauth_states
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE commerce_events
    ADD COLUMN IF NOT EXISTS provider_event_id text,
    ADD COLUMN IF NOT EXISTS provider_topic text;

ALTER TABLE commerce_orders
    ADD COLUMN IF NOT EXISTS raw jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS commerce_events_provider_event_unique
    ON commerce_events (tenant_id, integration_id, provider_event_id)
    WHERE provider_event_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Visual automation execution state for compatibility journeys
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automation_journey_executions (
    id                text PRIMARY KEY,
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    journey_id        uuid NOT NULL REFERENCES automation_journeys(id) ON DELETE CASCADE,
    subscriber_email  citext NOT NULL,
    status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'waiting', 'completed', 'paused', 'failed')),
    current_node_id   text,
    completed_nodes   text[] NOT NULL DEFAULT '{}',
    payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at        timestamptz NOT NULL DEFAULT now(),
    last_at           timestamptz NOT NULL DEFAULT now(),
    next_run_at       timestamptz,
    error             text,
    UNIQUE (tenant_id, journey_id, subscriber_email)
);

CREATE INDEX IF NOT EXISTS automation_journey_executions_tenant_idx
    ON automation_journey_executions (tenant_id, journey_id, last_at DESC);
CREATE INDEX IF NOT EXISTS automation_journey_executions_due_idx
    ON automation_journey_executions (tenant_id, next_run_at)
    WHERE status IN ('active', 'waiting');

GRANT SELECT, INSERT, UPDATE, DELETE ON automation_journey_executions TO postwave_app;

ALTER TABLE automation_journey_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_journey_executions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON automation_journey_executions;
CREATE POLICY tenant_isolation ON automation_journey_executions
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS automation_journey_events (
    id               bigserial PRIMARY KEY,
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    automation_id     uuid NOT NULL,
    subscriber_email  citext,
    event_type        text NOT NULL,
    node_id           text,
    status            text,
    message           text,
    payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
    at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS automation_journey_events_tenant_idx
    ON automation_journey_events (tenant_id, automation_id, at DESC);
CREATE INDEX IF NOT EXISTS automation_journey_events_subscriber_idx
    ON automation_journey_events (tenant_id, subscriber_email, at DESC)
    WHERE subscriber_email IS NOT NULL;

GRANT SELECT, INSERT ON automation_journey_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE automation_journey_events_id_seq TO postwave_app;

ALTER TABLE automation_journey_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_journey_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON automation_journey_events;
CREATE POLICY tenant_isolation ON automation_journey_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Plan usage snapshots for API/UI gates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_usage_snapshots (
    tenant_id              uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    contacts               integer NOT NULL DEFAULT 0,
    campaigns              integer NOT NULL DEFAULT 0,
    automations            integer NOT NULL DEFAULT 0,
    landing_pages          integer NOT NULL DEFAULT 0,
    popup_forms            integer NOT NULL DEFAULT 0,
    ecommerce_integrations integer NOT NULL DEFAULT 0,
    monthly_sends          integer NOT NULL DEFAULT 0,
    month_start            date NOT NULL DEFAULT date_trunc('month', now())::date,
    recomputed_at          timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_usage_snapshots TO postwave_app;

ALTER TABLE tenant_usage_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_usage_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_usage_snapshots;
CREATE POLICY tenant_isolation ON tenant_usage_snapshots
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
