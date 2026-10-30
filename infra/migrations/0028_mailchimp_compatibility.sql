-- 0028_mailchimp_compatibility.sql
--
-- Mailchimp compatibility layer. These tables and subscriber/campaign columns
-- preserve the data shapes Mailchimp switchers expect: exact contact status
-- semantics, merge fields, groups/interests, GDPR permissions, advanced
-- campaign builder assets, campaign reporting events, visual journey graphs,
-- hosted landing/popup surfaces, and ecommerce attribution records.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Contact/audience compatibility
-- ---------------------------------------------------------------------------
ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS mailchimp_status text NOT NULL DEFAULT 'subscribed'
        CHECK (mailchimp_status IN (
            'subscribed', 'unsubscribed', 'non_subscribed', 'cleaned',
            'archived', 'deleted'
        )),
    ADD COLUMN IF NOT EXISTS merge_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS groups jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS gdpr_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS signup_ip inet,
    ADD COLUMN IF NOT EXISTS unsubscribe_reason text,
    ADD COLUMN IF NOT EXISTS mailchimp_last_changed timestamptz,
    ADD COLUMN IF NOT EXISTS activity_summary jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS subscribers_mailchimp_status_idx
    ON subscribers (tenant_id, mailchimp_status);
CREATE INDEX IF NOT EXISTS subscribers_merge_fields_gin
    ON subscribers USING GIN (merge_fields);
CREATE INDEX IF NOT EXISTS subscribers_groups_gin
    ON subscribers USING GIN (groups);
CREATE INDEX IF NOT EXISTS subscribers_gdpr_permissions_gin
    ON subscribers USING GIN (gdpr_permissions);

CREATE TABLE IF NOT EXISTS subscriber_groups (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    category      text NOT NULL,
    name          text NOT NULL,
    type          text NOT NULL DEFAULT 'checkbox'
                  CHECK (type IN ('checkbox', 'radio', 'dropdown', 'hidden')),
    display_order integer NOT NULL DEFAULT 0,
    source_id     text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, category, name)
);

CREATE INDEX IF NOT EXISTS subscriber_groups_tenant_idx
    ON subscriber_groups (tenant_id, category, display_order);

DROP TRIGGER IF EXISTS subscriber_groups_set_updated_at ON subscriber_groups;
CREATE TRIGGER subscriber_groups_set_updated_at
    BEFORE UPDATE ON subscriber_groups
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_groups TO postwave_app;

ALTER TABLE subscriber_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_groups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON subscriber_groups;
CREATE POLICY tenant_isolation ON subscriber_groups
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS contact_activity (
    id                bigserial PRIMARY KEY,
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_email  citext NOT NULL,
    activity_type     text NOT NULL CHECK (activity_type IN (
        'imported', 'subscribed', 'unsubscribed', 'profile_updated',
        'email_sent', 'email_opened', 'email_clicked', 'bounced',
        'complained', 'order_created', 'tag_added', 'tag_removed',
        'group_joined', 'group_left', 'gdpr_updated'
    )),
    campaign_id       uuid,
    metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
    source            text,
    at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_activity_contact_idx
    ON contact_activity (tenant_id, subscriber_email, at DESC);
CREATE INDEX IF NOT EXISTS contact_activity_campaign_idx
    ON contact_activity (tenant_id, campaign_id, at DESC);

GRANT SELECT, INSERT ON contact_activity TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE contact_activity_id_seq TO postwave_app;

ALTER TABLE contact_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_activity FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON contact_activity;
CREATE POLICY tenant_isolation ON contact_activity
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Campaign builder + reports
-- ---------------------------------------------------------------------------
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS campaign_type text NOT NULL DEFAULT 'regular'
        CHECK (campaign_type IN (
            'regular', 'plain_text', 'ab_test', 'rss', 'automated', 'transactional'
        )),
    ADD COLUMN IF NOT EXISTS editor_mode text NOT NULL DEFAULT 'blocks'
        CHECK (editor_mode IN ('blocks', 'html', 'plain_text', 'mjml')),
    ADD COLUMN IF NOT EXISTS preview_text text,
    ADD COLUMN IF NOT EXISTS plain_text text,
    ADD COLUMN IF NOT EXISTS from_name text,
    ADD COLUMN IF NOT EXISTS reply_to citext,
    ADD COLUMN IF NOT EXISTS content_blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS reusable_section_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    ADD COLUMN IF NOT EXISTS variants jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS tracking_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS delivery_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS campaigns_tenant_type_idx
    ON campaigns (tenant_id, campaign_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS campaigns_content_blocks_gin
    ON campaigns USING GIN (content_blocks);

CREATE TABLE IF NOT EXISTS campaign_assets (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        text NOT NULL,
    asset_type  text NOT NULL CHECK (asset_type IN ('image', 'file', 'video', 'product')),
    url         text NOT NULL,
    alt_text    text,
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_assets_tenant_idx
    ON campaign_assets (tenant_id, asset_type, updated_at DESC);

DROP TRIGGER IF EXISTS campaign_assets_set_updated_at ON campaign_assets;
CREATE TRIGGER campaign_assets_set_updated_at
    BEFORE UPDATE ON campaign_assets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_assets TO postwave_app;

ALTER TABLE campaign_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON campaign_assets;
CREATE POLICY tenant_isolation ON campaign_assets
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS campaign_sections (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        text NOT NULL,
    category    text NOT NULL DEFAULT 'general',
    blocks      jsonb NOT NULL DEFAULT '[]'::jsonb,
    html        text,
    mjml        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS campaign_sections_tenant_idx
    ON campaign_sections (tenant_id, category, updated_at DESC);

DROP TRIGGER IF EXISTS campaign_sections_set_updated_at ON campaign_sections;
CREATE TRIGGER campaign_sections_set_updated_at
    BEFORE UPDATE ON campaign_sections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_sections TO postwave_app;

ALTER TABLE campaign_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_sections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON campaign_sections;
CREATE POLICY tenant_isolation ON campaign_sections
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS campaign_report_events (
    id               bigserial PRIMARY KEY,
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    subscriber_email citext,
    event_type       text NOT NULL CHECK (event_type IN (
        'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained',
        'unsubscribed', 'conversion'
    )),
    link_url         text,
    user_agent       text,
    ip               inet,
    country          text,
    region           text,
    city             text,
    device           text,
    client           text,
    revenue_cents    integer NOT NULL DEFAULT 0,
    metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
    at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_report_events_campaign_idx
    ON campaign_report_events (tenant_id, campaign_id, event_type, at DESC);
CREATE INDEX IF NOT EXISTS campaign_report_events_contact_idx
    ON campaign_report_events (tenant_id, subscriber_email, at DESC);

GRANT SELECT, INSERT ON campaign_report_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE campaign_report_events_id_seq TO postwave_app;

ALTER TABLE campaign_report_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_report_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON campaign_report_events;
CREATE POLICY tenant_isolation ON campaign_report_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Visual automation builder
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automation_journeys (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        text NOT NULL,
    status      text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'active', 'paused', 'archived')),
    version     integer NOT NULL DEFAULT 1,
    triggers    jsonb NOT NULL DEFAULT '[]'::jsonb,
    nodes       jsonb NOT NULL DEFAULT '[]'::jsonb,
    edges       jsonb NOT NULL DEFAULT '[]'::jsonb,
    goals       jsonb NOT NULL DEFAULT '[]'::jsonb,
    analytics   jsonb NOT NULL DEFAULT '{}'::jsonb,
    published_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS automation_journeys_tenant_status_idx
    ON automation_journeys (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS automation_journeys_nodes_gin
    ON automation_journeys USING GIN (nodes);

DROP TRIGGER IF EXISTS automation_journeys_set_updated_at ON automation_journeys;
CREATE TRIGGER automation_journeys_set_updated_at
    BEFORE UPDATE ON automation_journeys
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON automation_journeys TO postwave_app;

ALTER TABLE automation_journeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_journeys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON automation_journeys;
CREATE POLICY tenant_isolation ON automation_journeys
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Landing pages + popups
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS landing_pages (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    slug          citext NOT NULL,
    name          text NOT NULL,
    status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'published', 'archived')),
    domain        text,
    template      text NOT NULL DEFAULT 'signup',
    blocks        jsonb NOT NULL DEFAULT '[]'::jsonb,
    seo           jsonb NOT NULL DEFAULT '{}'::jsonb,
    tracking      jsonb NOT NULL DEFAULT '{}'::jsonb,
    metrics       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS landing_pages_tenant_status_idx
    ON landing_pages (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS landing_pages_slug_published_idx
    ON landing_pages (slug) WHERE status = 'published';

DROP TRIGGER IF EXISTS landing_pages_set_updated_at ON landing_pages;
CREATE TRIGGER landing_pages_set_updated_at
    BEFORE UPDATE ON landing_pages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON landing_pages TO postwave_app;

ALTER TABLE landing_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE landing_pages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON landing_pages;
CREATE POLICY tenant_isolation ON landing_pages
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS landing_pages_public_lookup ON landing_pages;
CREATE POLICY landing_pages_public_lookup ON landing_pages
    FOR SELECT
    USING (
        status = 'published'
        AND slug = NULLIF(current_setting('app.public_landing_slug', true), '')::citext
    );

CREATE TABLE IF NOT EXISTS popup_forms (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name          text NOT NULL,
    status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'published', 'paused', 'archived')),
    trigger       jsonb NOT NULL DEFAULT '{}'::jsonb,
    targeting     jsonb NOT NULL DEFAULT '{}'::jsonb,
    blocks        jsonb NOT NULL DEFAULT '[]'::jsonb,
    form_id       uuid REFERENCES forms(id) ON DELETE SET NULL,
    metrics       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS popup_forms_tenant_status_idx
    ON popup_forms (tenant_id, status, updated_at DESC);

DROP TRIGGER IF EXISTS popup_forms_set_updated_at ON popup_forms;
CREATE TRIGGER popup_forms_set_updated_at
    BEFORE UPDATE ON popup_forms
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON popup_forms TO postwave_app;

ALTER TABLE popup_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE popup_forms FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON popup_forms;
CREATE POLICY tenant_isolation ON popup_forms
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS growth_surface_events (
    id            bigserial PRIMARY KEY,
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    surface_type  text NOT NULL CHECK (surface_type IN ('landing_page', 'popup')),
    surface_id    uuid NOT NULL,
    event_type    text NOT NULL CHECK (event_type IN ('view', 'submit', 'conversion')),
    email         citext,
    metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
    at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS growth_surface_events_surface_idx
    ON growth_surface_events (tenant_id, surface_type, surface_id, event_type, at DESC);

GRANT SELECT, INSERT ON growth_surface_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE growth_surface_events_id_seq TO postwave_app;

ALTER TABLE growth_surface_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_surface_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON growth_surface_events;
CREATE POLICY tenant_isolation ON growth_surface_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Ecommerce integrations + attribution
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_integrations (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider       text NOT NULL CHECK (provider IN ('shopify', 'woocommerce', 'stripe', 'square')),
    shop_domain    text,
    status         text NOT NULL DEFAULT 'connected'
                   CHECK (status IN ('connected', 'needs_auth', 'syncing', 'paused', 'error')),
    scopes         text[] NOT NULL DEFAULT '{}'::text[],
    settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
    sync_cursor    text,
    last_sync_at   timestamptz,
    error_message  text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, provider, shop_domain)
);

CREATE INDEX IF NOT EXISTS commerce_integrations_tenant_idx
    ON commerce_integrations (tenant_id, provider, status);

DROP TRIGGER IF EXISTS commerce_integrations_set_updated_at ON commerce_integrations;
CREATE TRIGGER commerce_integrations_set_updated_at
    BEFORE UPDATE ON commerce_integrations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_integrations TO postwave_app;

ALTER TABLE commerce_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_integrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commerce_integrations;
CREATE POLICY tenant_isolation ON commerce_integrations
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS commerce_customers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id  uuid NOT NULL REFERENCES commerce_integrations(id) ON DELETE CASCADE,
    source_id       text NOT NULL,
    email           citext,
    first_name      text,
    last_name       text,
    accepts_marketing boolean NOT NULL DEFAULT false,
    tags            text[] NOT NULL DEFAULT '{}'::text[],
    raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, integration_id, source_id)
);

CREATE INDEX IF NOT EXISTS commerce_customers_email_idx
    ON commerce_customers (tenant_id, email);

GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_customers TO postwave_app;

ALTER TABLE commerce_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_customers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commerce_customers;
CREATE POLICY tenant_isolation ON commerce_customers
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS commerce_products (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id  uuid NOT NULL REFERENCES commerce_integrations(id) ON DELETE CASCADE,
    source_id       text NOT NULL,
    title           text NOT NULL,
    url             text,
    image_url       text,
    price_cents     integer NOT NULL DEFAULT 0,
    currency        text NOT NULL DEFAULT 'USD',
    raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, integration_id, source_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_products TO postwave_app;

ALTER TABLE commerce_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_products FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commerce_products;
CREATE POLICY tenant_isolation ON commerce_products
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS commerce_orders (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id      uuid NOT NULL REFERENCES commerce_integrations(id) ON DELETE CASCADE,
    source_id           text NOT NULL,
    customer_email      citext,
    status              text NOT NULL DEFAULT 'paid'
                        CHECK (status IN ('pending', 'paid', 'refunded', 'cancelled')),
    subtotal_cents      integer NOT NULL DEFAULT 0,
    discount_cents      integer NOT NULL DEFAULT 0,
    shipping_cents      integer NOT NULL DEFAULT 0,
    tax_cents           integer NOT NULL DEFAULT 0,
    total_cents         integer NOT NULL DEFAULT 0,
    currency            text NOT NULL DEFAULT 'USD',
    campaign_id         uuid REFERENCES campaigns(id) ON DELETE SET NULL,
    attribution         jsonb NOT NULL DEFAULT '{}'::jsonb,
    line_items          jsonb NOT NULL DEFAULT '[]'::jsonb,
    ordered_at          timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, integration_id, source_id)
);

CREATE INDEX IF NOT EXISTS commerce_orders_customer_idx
    ON commerce_orders (tenant_id, customer_email, ordered_at DESC);
CREATE INDEX IF NOT EXISTS commerce_orders_campaign_idx
    ON commerce_orders (tenant_id, campaign_id, ordered_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_orders TO postwave_app;

ALTER TABLE commerce_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commerce_orders;
CREATE POLICY tenant_isolation ON commerce_orders
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS commerce_events (
    id             bigserial PRIMARY KEY,
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id uuid NOT NULL REFERENCES commerce_integrations(id) ON DELETE CASCADE,
    event_type     text NOT NULL CHECK (event_type IN (
        'customer_created', 'product_created', 'order_created',
        'order_refunded', 'cart_abandoned', 'sync_started', 'sync_completed'
    )),
    customer_email citext,
    order_id       uuid,
    metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
    at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commerce_events_tenant_idx
    ON commerce_events (tenant_id, integration_id, event_type, at DESC);

GRANT SELECT, INSERT ON commerce_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE commerce_events_id_seq TO postwave_app;

ALTER TABLE commerce_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commerce_events;
CREATE POLICY tenant_isolation ON commerce_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
