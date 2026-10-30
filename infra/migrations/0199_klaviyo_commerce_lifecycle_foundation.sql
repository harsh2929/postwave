-- 0199_klaviyo_commerce_lifecycle_foundation.sql
--
-- Klaviyo commerce-lifecycle parity foundation. This is intentionally
-- additive beside the existing commerce_integrations / commerce_products /
-- commerce_orders tables so current Shopify sync and Mailchimp-compatible
-- ecommerce APIs keep their contracts while richer catalog/feed/inventory
-- features are built.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS commerce_catalogs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id  uuid REFERENCES commerce_integrations(id) ON DELETE SET NULL,
    name            text NOT NULL,
    source_type     text NOT NULL DEFAULT 'integration'
                    CHECK (source_type IN ('integration', 'json_feed', 'api', 'manual')),
    feed_url        text,
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('draft', 'active', 'paused', 'archived', 'error')),
    locale          text,
    default_currency text NOT NULL DEFAULT 'USD',
    settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_sync_at    timestamptz,
    error_message   text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS commerce_catalogs_tenant_idx
    ON commerce_catalogs (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS commerce_catalogs_integration_idx
    ON commerce_catalogs (tenant_id, integration_id)
    WHERE integration_id IS NOT NULL;

DROP TRIGGER IF EXISTS commerce_catalogs_set_updated_at ON commerce_catalogs;
CREATE TRIGGER commerce_catalogs_set_updated_at
    BEFORE UPDATE ON commerce_catalogs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_catalogs TO postwave_app;

ALTER TABLE commerce_catalogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_catalogs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commerce_catalogs;
CREATE POLICY tenant_isolation ON commerce_catalogs
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS commerce_product_variants (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id  uuid NOT NULL REFERENCES commerce_integrations(id) ON DELETE CASCADE,
    product_id      uuid NOT NULL REFERENCES commerce_products(id) ON DELETE CASCADE,
    source_id       text NOT NULL,
    sku             text,
    title           text,
    option_values   jsonb NOT NULL DEFAULT '{}'::jsonb,
    price_cents     integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
    compare_at_price_cents integer CHECK (
        compare_at_price_cents IS NULL OR compare_at_price_cents >= 0
    ),
    currency        text NOT NULL DEFAULT 'USD',
    inventory_quantity integer,
    inventory_policy text NOT NULL DEFAULT 'deny'
                    CHECK (inventory_policy IN ('deny', 'continue', 'unknown')),
    available       boolean NOT NULL DEFAULT true,
    image_url       text,
    url             text,
    raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, integration_id, source_id)
);

CREATE INDEX IF NOT EXISTS commerce_product_variants_product_idx
    ON commerce_product_variants (tenant_id, product_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS commerce_product_variants_sku_idx
    ON commerce_product_variants (tenant_id, sku)
    WHERE sku IS NOT NULL AND sku <> '';
CREATE INDEX IF NOT EXISTS commerce_product_variants_available_idx
    ON commerce_product_variants (tenant_id, available, updated_at DESC);

DROP TRIGGER IF EXISTS commerce_product_variants_set_updated_at ON commerce_product_variants;
CREATE TRIGGER commerce_product_variants_set_updated_at
    BEFORE UPDATE ON commerce_product_variants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_product_variants TO postwave_app;

ALTER TABLE commerce_product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_product_variants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commerce_product_variants;
CREATE POLICY tenant_isolation ON commerce_product_variants
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS commerce_catalog_items (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    catalog_id  uuid NOT NULL REFERENCES commerce_catalogs(id) ON DELETE CASCADE,
    product_id  uuid NOT NULL REFERENCES commerce_products(id) ON DELETE CASCADE,
    variant_id  uuid REFERENCES commerce_product_variants(id) ON DELETE CASCADE,
    collection  text,
    position    integer NOT NULL DEFAULT 0,
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commerce_catalog_items_catalog_idx
    ON commerce_catalog_items (tenant_id, catalog_id, position, updated_at DESC);
CREATE INDEX IF NOT EXISTS commerce_catalog_items_product_idx
    ON commerce_catalog_items (tenant_id, product_id);

DROP TRIGGER IF EXISTS commerce_catalog_items_set_updated_at ON commerce_catalog_items;
CREATE TRIGGER commerce_catalog_items_set_updated_at
    BEFORE UPDATE ON commerce_catalog_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_catalog_items TO postwave_app;

ALTER TABLE commerce_catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_catalog_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commerce_catalog_items;
CREATE POLICY tenant_isolation ON commerce_catalog_items
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS commerce_inventory_snapshots (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id  uuid NOT NULL REFERENCES commerce_integrations(id) ON DELETE CASCADE,
    product_id      uuid NOT NULL REFERENCES commerce_products(id) ON DELETE CASCADE,
    variant_id      uuid REFERENCES commerce_product_variants(id) ON DELETE CASCADE,
    quantity        integer,
    available       boolean NOT NULL DEFAULT true,
    inventory_policy text NOT NULL DEFAULT 'unknown'
                    CHECK (inventory_policy IN ('deny', 'continue', 'unknown')),
    observed_at     timestamptz NOT NULL DEFAULT now(),
    source_event_id text,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS commerce_inventory_snapshots_product_idx
    ON commerce_inventory_snapshots (tenant_id, product_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS commerce_inventory_snapshots_variant_idx
    ON commerce_inventory_snapshots (tenant_id, variant_id, observed_at DESC)
    WHERE variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_inventory_snapshots_available_idx
    ON commerce_inventory_snapshots (tenant_id, available, observed_at DESC);

GRANT SELECT, INSERT ON commerce_inventory_snapshots TO postwave_app;

ALTER TABLE commerce_inventory_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_inventory_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commerce_inventory_snapshots;
CREATE POLICY tenant_isolation ON commerce_inventory_snapshots
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS commerce_price_history (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id  uuid NOT NULL REFERENCES commerce_integrations(id) ON DELETE CASCADE,
    product_id      uuid NOT NULL REFERENCES commerce_products(id) ON DELETE CASCADE,
    variant_id      uuid REFERENCES commerce_product_variants(id) ON DELETE CASCADE,
    price_cents     integer NOT NULL CHECK (price_cents >= 0),
    compare_at_price_cents integer CHECK (
        compare_at_price_cents IS NULL OR compare_at_price_cents >= 0
    ),
    currency        text NOT NULL DEFAULT 'USD',
    observed_at     timestamptz NOT NULL DEFAULT now(),
    source_event_id text,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS commerce_price_history_product_idx
    ON commerce_price_history (tenant_id, product_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS commerce_price_history_variant_idx
    ON commerce_price_history (tenant_id, variant_id, observed_at DESC)
    WHERE variant_id IS NOT NULL;

GRANT SELECT, INSERT ON commerce_price_history TO postwave_app;

ALTER TABLE commerce_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_price_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commerce_price_history;
CREATE POLICY tenant_isolation ON commerce_price_history
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS commerce_product_feeds (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    catalog_id  uuid REFERENCES commerce_catalogs(id) ON DELETE SET NULL,
    name        text NOT NULL,
    feed_type   text NOT NULL DEFAULT 'manual'
                CHECK (feed_type IN (
                    'manual', 'dynamic', 'behavioral_recommendation',
                    'best_sellers', 'recently_viewed', 'back_in_stock',
                    'price_drop'
                )),
    status      text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'published', 'paused', 'archived')),
    criteria    jsonb NOT NULL DEFAULT '{}'::jsonb,
    fallback    jsonb NOT NULL DEFAULT '{}'::jsonb,
    max_items   integer NOT NULL DEFAULT 3 CHECK (max_items > 0 AND max_items <= 50),
    exclude_out_of_stock boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS commerce_product_feeds_tenant_idx
    ON commerce_product_feeds (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS commerce_product_feeds_catalog_idx
    ON commerce_product_feeds (tenant_id, catalog_id)
    WHERE catalog_id IS NOT NULL;

DROP TRIGGER IF EXISTS commerce_product_feeds_set_updated_at ON commerce_product_feeds;
CREATE TRIGGER commerce_product_feeds_set_updated_at
    BEFORE UPDATE ON commerce_product_feeds
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_product_feeds TO postwave_app;

ALTER TABLE commerce_product_feeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_product_feeds FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commerce_product_feeds;
CREATE POLICY tenant_isolation ON commerce_product_feeds
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS commerce_product_feed_items (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    feed_id     uuid NOT NULL REFERENCES commerce_product_feeds(id) ON DELETE CASCADE,
    product_id  uuid NOT NULL REFERENCES commerce_products(id) ON DELETE CASCADE,
    variant_id  uuid REFERENCES commerce_product_variants(id) ON DELETE CASCADE,
    rank        integer NOT NULL DEFAULT 0,
    reason      text,
    score       numeric(12, 6),
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commerce_product_feed_items_feed_idx
    ON commerce_product_feed_items (tenant_id, feed_id, rank, updated_at DESC);
CREATE INDEX IF NOT EXISTS commerce_product_feed_items_product_idx
    ON commerce_product_feed_items (tenant_id, product_id);

DROP TRIGGER IF EXISTS commerce_product_feed_items_set_updated_at ON commerce_product_feed_items;
CREATE TRIGGER commerce_product_feed_items_set_updated_at
    BEFORE UPDATE ON commerce_product_feed_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_product_feed_items TO postwave_app;

ALTER TABLE commerce_product_feed_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_product_feed_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commerce_product_feed_items;
CREATE POLICY tenant_isolation ON commerce_product_feed_items
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS commerce_metric_definitions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    canonical_name  text NOT NULL,
    event_name      text NOT NULL,
    source          text NOT NULL DEFAULT 'postwave'
                    CHECK (source IN ('postwave', 'shopify', 'json_feed', 'api', 'migration')),
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'deprecated', 'archived')),
    schema          jsonb NOT NULL DEFAULT '{}'::jsonb,
    activation      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, canonical_name, source)
);

CREATE INDEX IF NOT EXISTS commerce_metric_definitions_event_idx
    ON commerce_metric_definitions (tenant_id, event_name, status);

DROP TRIGGER IF EXISTS commerce_metric_definitions_set_updated_at ON commerce_metric_definitions;
CREATE TRIGGER commerce_metric_definitions_set_updated_at
    BEFORE UPDATE ON commerce_metric_definitions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_metric_definitions TO postwave_app;

ALTER TABLE commerce_metric_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_metric_definitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commerce_metric_definitions;
CREATE POLICY tenant_isolation ON commerce_metric_definitions
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE commerce_events
    DROP CONSTRAINT IF EXISTS commerce_events_event_type_check;
ALTER TABLE commerce_events
    ADD CONSTRAINT commerce_events_event_type_check CHECK (event_type IN (
        'customer_created',
        'product_created',
        'order_created',
        'order_refunded',
        'cart_abandoned',
        'sync_started',
        'sync_completed',
        'catalog_products_imported',
        'cart_recovery_link_created',
        'back_in_stock_requested',
        'back_in_stock_eligible',
        'price_drop_watcher_created',
        'price_drop_eligible'
    ));

CREATE TABLE IF NOT EXISTS commerce_cart_recovery_links (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id  uuid NOT NULL REFERENCES commerce_integrations(id) ON DELETE CASCADE,
    cart_order_id   uuid REFERENCES commerce_orders(id) ON DELETE CASCADE,
    source_cart_id  text NOT NULL,
    customer_email  citext,
    recovery_url    text NOT NULL,
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'converted', 'expired', 'disabled')),
    expires_at      timestamptz,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, integration_id, source_cart_id)
);

CREATE INDEX IF NOT EXISTS commerce_cart_recovery_links_customer_idx
    ON commerce_cart_recovery_links (tenant_id, customer_email, updated_at DESC)
    WHERE customer_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_cart_recovery_links_status_idx
    ON commerce_cart_recovery_links (tenant_id, status, updated_at DESC);

DROP TRIGGER IF EXISTS commerce_cart_recovery_links_set_updated_at ON commerce_cart_recovery_links;
CREATE TRIGGER commerce_cart_recovery_links_set_updated_at
    BEFORE UPDATE ON commerce_cart_recovery_links
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_cart_recovery_links TO postwave_app;

ALTER TABLE commerce_cart_recovery_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_cart_recovery_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commerce_cart_recovery_links;
CREATE POLICY tenant_isolation ON commerce_cart_recovery_links
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS back_in_stock_subscriptions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id  uuid NOT NULL REFERENCES commerce_integrations(id) ON DELETE CASCADE,
    product_id      uuid NOT NULL REFERENCES commerce_products(id) ON DELETE CASCADE,
    variant_id      uuid REFERENCES commerce_product_variants(id) ON DELETE CASCADE,
    subscriber_id   uuid REFERENCES subscribers(id) ON DELETE SET NULL,
    subscriber_email citext,
    status          text NOT NULL DEFAULT 'waiting'
                    CHECK (status IN ('waiting', 'eligible', 'notified', 'expired', 'cancelled')),
    requested_at    timestamptz NOT NULL DEFAULT now(),
    eligible_at     timestamptz,
    notified_at     timestamptz,
    expires_at      timestamptz,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (subscriber_id IS NOT NULL OR subscriber_email IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS back_in_stock_subscriptions_product_idx
    ON back_in_stock_subscriptions (tenant_id, product_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS back_in_stock_subscriptions_variant_idx
    ON back_in_stock_subscriptions (tenant_id, variant_id, status, requested_at DESC)
    WHERE variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS back_in_stock_subscriptions_subscriber_idx
    ON back_in_stock_subscriptions (tenant_id, subscriber_id, requested_at DESC)
    WHERE subscriber_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS back_in_stock_subscriptions_email_idx
    ON back_in_stock_subscriptions (tenant_id, subscriber_email, requested_at DESC)
    WHERE subscriber_email IS NOT NULL;

DROP TRIGGER IF EXISTS back_in_stock_subscriptions_set_updated_at ON back_in_stock_subscriptions;
CREATE TRIGGER back_in_stock_subscriptions_set_updated_at
    BEFORE UPDATE ON back_in_stock_subscriptions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON back_in_stock_subscriptions TO postwave_app;

ALTER TABLE back_in_stock_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE back_in_stock_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON back_in_stock_subscriptions;
CREATE POLICY tenant_isolation ON back_in_stock_subscriptions
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS back_in_stock_subscriptions_worker_select ON back_in_stock_subscriptions;
CREATE POLICY back_in_stock_subscriptions_worker_select ON back_in_stock_subscriptions
    AS PERMISSIVE
    FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

CREATE TABLE IF NOT EXISTS price_drop_watchers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id  uuid NOT NULL REFERENCES commerce_integrations(id) ON DELETE CASCADE,
    product_id      uuid NOT NULL REFERENCES commerce_products(id) ON DELETE CASCADE,
    variant_id      uuid REFERENCES commerce_product_variants(id) ON DELETE CASCADE,
    subscriber_id   uuid REFERENCES subscribers(id) ON DELETE SET NULL,
    subscriber_email citext,
    original_price_cents integer NOT NULL CHECK (original_price_cents >= 0),
    target_price_cents integer CHECK (
        target_price_cents IS NULL OR target_price_cents >= 0
    ),
    min_drop_percent integer CHECK (
        min_drop_percent IS NULL OR (min_drop_percent > 0 AND min_drop_percent <= 100)
    ),
    currency        text NOT NULL DEFAULT 'USD',
    status          text NOT NULL DEFAULT 'watching'
                    CHECK (status IN ('watching', 'eligible', 'notified', 'expired', 'cancelled')),
    watched_at      timestamptz NOT NULL DEFAULT now(),
    eligible_at     timestamptz,
    notified_at     timestamptz,
    expires_at      timestamptz,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (subscriber_id IS NOT NULL OR subscriber_email IS NOT NULL),
    CHECK (target_price_cents IS NOT NULL OR min_drop_percent IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS price_drop_watchers_product_idx
    ON price_drop_watchers (tenant_id, product_id, status, watched_at DESC);
CREATE INDEX IF NOT EXISTS price_drop_watchers_variant_idx
    ON price_drop_watchers (tenant_id, variant_id, status, watched_at DESC)
    WHERE variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS price_drop_watchers_subscriber_idx
    ON price_drop_watchers (tenant_id, subscriber_id, watched_at DESC)
    WHERE subscriber_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS price_drop_watchers_email_idx
    ON price_drop_watchers (tenant_id, subscriber_email, watched_at DESC)
    WHERE subscriber_email IS NOT NULL;

DROP TRIGGER IF EXISTS price_drop_watchers_set_updated_at ON price_drop_watchers;
CREATE TRIGGER price_drop_watchers_set_updated_at
    BEFORE UPDATE ON price_drop_watchers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON price_drop_watchers TO postwave_app;

ALTER TABLE price_drop_watchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_drop_watchers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON price_drop_watchers;
CREATE POLICY tenant_isolation ON price_drop_watchers
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS price_drop_watchers_worker_select ON price_drop_watchers;
CREATE POLICY price_drop_watchers_worker_select ON price_drop_watchers
    AS PERMISSIVE
    FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
