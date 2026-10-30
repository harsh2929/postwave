-- 0196_mailchimp_p0_switch_closure.sql
--
-- Final P0 switch-support hardening for Mailchimp migrations:
--   - imported carts can be represented in commerce_orders for Mailchimp
--     ecommerce/cart API parity;
--   - Mailchimp developer-platform compatibility resources persist across
--     API restarts instead of living only in process memory.

BEGIN;

ALTER TABLE commerce_orders DROP CONSTRAINT IF EXISTS commerce_orders_status_check;
ALTER TABLE commerce_orders ADD CONSTRAINT commerce_orders_status_check
    CHECK (status IN ('pending', 'paid', 'refunded', 'cancelled', 'cart'));

CREATE TABLE IF NOT EXISTS mailchimp_platform_state (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    kind        text NOT NULL CHECK (kind IN (
        'batch', 'batch_webhook', 'account_export',
        'connected_site', 'verified_domain'
    )),
    item_id     text NOT NULL,
    payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, kind, item_id)
);

CREATE INDEX IF NOT EXISTS mailchimp_platform_state_tenant_kind_idx
    ON mailchimp_platform_state (tenant_id, kind, updated_at DESC);

DROP TRIGGER IF EXISTS mailchimp_platform_state_set_updated_at ON mailchimp_platform_state;
CREATE TRIGGER mailchimp_platform_state_set_updated_at
    BEFORE UPDATE ON mailchimp_platform_state
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON mailchimp_platform_state TO postwave_app;

ALTER TABLE mailchimp_platform_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailchimp_platform_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mailchimp_platform_state;
CREATE POLICY tenant_isolation ON mailchimp_platform_state
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
