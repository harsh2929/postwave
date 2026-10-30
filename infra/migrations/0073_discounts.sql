-- 0040_discounts.sql
--
-- Tenant-scoped discount codes that bridge to Stripe coupons / promotion
-- codes when a paid subscription is created. Redemptions are tracked
-- locally so we can enforce max_redemptions independently of Stripe and
-- so the dashboard can report on usage without round-tripping the API.

BEGIN;

CREATE TABLE discounts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code                text NOT NULL,
    percent_off         smallint,
    amount_off_cents    integer,
    currency            text NOT NULL DEFAULT 'usd',
    max_redemptions     integer,
    times_redeemed      integer NOT NULL DEFAULT 0,
    expires_at          timestamptz,
    applies_to          text NOT NULL CHECK (applies_to IN ('first_payment','recurring','both')),
    stripe_coupon_id    text,
    stripe_promo_id     text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, code),
    CHECK ((percent_off IS NOT NULL) <> (amount_off_cents IS NOT NULL))
);

CREATE INDEX discounts_tenant_idx ON discounts (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON discounts TO postwave_app;

ALTER TABLE discounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE discounts FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON discounts
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE TABLE discount_redemptions (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    discount_id     uuid NOT NULL REFERENCES discounts(id) ON DELETE CASCADE,
    subscriber_id   uuid,
    redeemed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX discount_redemptions_tenant_idx ON discount_redemptions (tenant_id, discount_id);

GRANT SELECT, INSERT ON discount_redemptions TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE discount_redemptions_id_seq TO postwave_app;

ALTER TABLE discount_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE discount_redemptions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON discount_redemptions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
