-- 0200_klaviyo_coupon_pools.sql
--
-- Klaviyo parity slice KLV-05: unique/dynamic coupon pools that can be
-- assigned idempotently per profile at message/form/customer-hub render time.

BEGIN;

CREATE TABLE coupon_pools (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    discount_id     uuid REFERENCES discounts(id) ON DELETE SET NULL,
    name            text NOT NULL,
    description     text NOT NULL DEFAULT '',
    provider        text NOT NULL DEFAULT 'postwave'
                    CHECK (provider IN ('postwave','shopify','woocommerce','manual')),
    provider_ref    text NOT NULL DEFAULT '',
    code_type       text NOT NULL
                    CHECK (code_type IN ('static','imported','generated')),
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('draft','active','paused','archived')),
    default_code    text NOT NULL DEFAULT '',
    expires_at      timestamptz,
    settings        jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name),
    CHECK (code_type <> 'static' OR default_code <> '' OR discount_id IS NOT NULL)
);

CREATE INDEX coupon_pools_tenant_status_idx
    ON coupon_pools (tenant_id, status, updated_at DESC);

CREATE TRIGGER coupon_pools_set_updated_at
    BEFORE UPDATE ON coupon_pools
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON coupon_pools TO postwave_app;

ALTER TABLE coupon_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_pools FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON coupon_pools
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON coupon_pools
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE coupon_codes (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    pool_id           uuid NOT NULL REFERENCES coupon_pools(id) ON DELETE CASCADE,
    code              text NOT NULL,
    status            text NOT NULL DEFAULT 'available'
                      CHECK (status IN ('available','reserved','assigned','redeemed','expired','disabled')),
    subscriber_id     uuid,
    subscriber_email  text NOT NULL DEFAULT '',
    context_key       text NOT NULL DEFAULT '',
    assigned_at       timestamptz,
    reserved_until    timestamptz,
    redeemed_at       timestamptz,
    expires_at        timestamptz,
    metadata          jsonb NOT NULL DEFAULT '{}',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, pool_id, code)
);

CREATE INDEX coupon_codes_pool_status_idx
    ON coupon_codes (tenant_id, pool_id, status, created_at);

CREATE INDEX coupon_codes_assignee_idx
    ON coupon_codes (tenant_id, pool_id, subscriber_id, lower(subscriber_email))
    WHERE subscriber_id IS NOT NULL OR subscriber_email <> '';

CREATE TRIGGER coupon_codes_set_updated_at
    BEFORE UPDATE ON coupon_codes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON coupon_codes TO postwave_app;

ALTER TABLE coupon_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON coupon_codes
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON coupon_codes
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE coupon_assignments (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    pool_id           uuid NOT NULL REFERENCES coupon_pools(id) ON DELETE CASCADE,
    code_id           uuid REFERENCES coupon_codes(id) ON DELETE SET NULL,
    static_code       text NOT NULL DEFAULT '',
    subscriber_id     uuid,
    subscriber_email  text NOT NULL DEFAULT '',
    context_key       text NOT NULL DEFAULT '',
    render_key        text NOT NULL DEFAULT '',
    channel           text NOT NULL DEFAULT '',
    surface           text NOT NULL DEFAULT '',
    status            text NOT NULL DEFAULT 'assigned'
                      CHECK (status IN ('reserved','assigned','redeemed','released','expired')),
    assigned_at       timestamptz NOT NULL DEFAULT now(),
    reserved_until    timestamptz,
    redeemed_at       timestamptz,
    expires_at        timestamptz,
    metadata          jsonb NOT NULL DEFAULT '{}',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX coupon_assignments_pool_status_idx
    ON coupon_assignments (tenant_id, pool_id, status, assigned_at DESC);

CREATE UNIQUE INDEX coupon_assignments_subscriber_context_idx
    ON coupon_assignments (tenant_id, pool_id, subscriber_id, context_key)
    WHERE subscriber_id IS NOT NULL
      AND context_key <> ''
      AND status IN ('reserved','assigned','redeemed');

CREATE UNIQUE INDEX coupon_assignments_email_context_idx
    ON coupon_assignments (tenant_id, pool_id, lower(subscriber_email), context_key)
    WHERE subscriber_email <> ''
      AND context_key <> ''
      AND status IN ('reserved','assigned','redeemed');

CREATE UNIQUE INDEX coupon_assignments_render_key_idx
    ON coupon_assignments (tenant_id, pool_id, render_key)
    WHERE render_key <> '';

CREATE TRIGGER coupon_assignments_set_updated_at
    BEFORE UPDATE ON coupon_assignments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON coupon_assignments TO postwave_app;

ALTER TABLE coupon_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON coupon_assignments
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON coupon_assignments
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE coupon_render_reservations (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    pool_id           uuid NOT NULL REFERENCES coupon_pools(id) ON DELETE CASCADE,
    assignment_id     uuid NOT NULL REFERENCES coupon_assignments(id) ON DELETE CASCADE,
    subscriber_id     uuid,
    subscriber_email  text NOT NULL DEFAULT '',
    context_key       text NOT NULL DEFAULT '',
    render_key        text NOT NULL,
    channel           text NOT NULL DEFAULT '',
    surface           text NOT NULL DEFAULT '',
    code              text NOT NULL,
    expires_at        timestamptz,
    metadata          jsonb NOT NULL DEFAULT '{}',
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, pool_id, render_key)
);

CREATE INDEX coupon_render_reservations_assignment_idx
    ON coupon_render_reservations (tenant_id, assignment_id);

GRANT SELECT, INSERT, DELETE ON coupon_render_reservations TO postwave_app;

ALTER TABLE coupon_render_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_render_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON coupon_render_reservations
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON coupon_render_reservations
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
