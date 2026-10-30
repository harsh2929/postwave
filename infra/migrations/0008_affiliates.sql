-- 0008_affiliates.sql
--
-- Affiliate program (Phase 4 per plan.md). Sits at the PLATFORM level — NOT
-- per-tenant — so RLS is intentionally not applied. Access control is enforced
-- at the API gateway via an admin-role check (placeholder middleware in
-- internal/affiliates until Clerk roles are wired). Affiliates refer
-- prospective customers; their tracking links / pixels write to
-- `affiliate_clicks`, and the Stripe webhook converts the last-touch click
-- (within 60 days) into an `affiliate_conversions` row when a tenant is
-- created or charged.
--
-- Commission rules (encoded in apps/api/internal/affiliates/affiliates.go):
--   * LTD purchase ($349 / $249 AppSumo) → flat $50 commission per sale.
--   * Sending tier ($29/mo) → 30% recurring while the customer keeps paying.
--   * Pro Sending tier ($79/mo) → 25% recurring while the customer keeps
--     paying.
-- Refunds + chargebacks reverse the matching conversion (status → 'reversed').

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- affiliates
-- ---------------------------------------------------------------------------
CREATE TABLE affiliates (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug               citext UNIQUE NOT NULL,
    email              citext NOT NULL,
    name               text NOT NULL,
    -- ISO-3166-1 alpha-2 country code (we accept the more permissive
    -- ISO-3166-2 region codes too, hence the relaxed length cap).
    country            text,
    status             text NOT NULL CHECK (status IN ('pending', 'approved', 'suspended', 'terminated')),
    payout_method      text CHECK (payout_method IN ('paypal', 'wise', 'stripe_connect')),
    payout_email       citext,
    tax_form_status    text CHECK (tax_form_status IN ('not_required', 'pending', 'submitted', 'expired')),
    tax_form_type      text CHECK (tax_form_type IN ('w9', 'w8ben', 'none')),
    notes              text,
    website            text,
    audience_size      integer,
    audience_desc      text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    approved_at        timestamptz,
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX affiliates_slug_idx    ON affiliates (slug);
CREATE INDEX affiliates_email_idx   ON affiliates (email);
CREATE INDEX affiliates_status_idx  ON affiliates (status);

CREATE TRIGGER affiliates_set_updated_at
    BEFORE UPDATE ON affiliates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Platform-level table — no RLS. Admin handlers gate access with a role
-- check. We still grant the application role so the gateway can read/write.
GRANT SELECT, INSERT, UPDATE, DELETE ON affiliates TO postwave_app;

-- ---------------------------------------------------------------------------
-- affiliate_clicks
-- ---------------------------------------------------------------------------
CREATE TABLE affiliate_clicks (
    id              bigserial PRIMARY KEY,
    affiliate_id    uuid NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
    ip              inet,
    user_agent      text,
    landing_page    text,
    utm_source      text,
    utm_medium      text,
    utm_campaign    text,
    utm_content     text,
    utm_term        text,
    -- High-entropy UUID set in the user's browser cookie. Last-touch
    -- attribution joins on this at conversion time.
    cookie_id       text NOT NULL,
    clicked_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX affiliate_clicks_affiliate_idx ON affiliate_clicks (affiliate_id, clicked_at DESC);
CREATE INDEX affiliate_clicks_cookie_idx    ON affiliate_clicks (cookie_id, clicked_at DESC);

GRANT SELECT, INSERT ON affiliate_clicks TO postwave_app;
GRANT USAGE ON SEQUENCE affiliate_clicks_id_seq TO postwave_app;

-- ---------------------------------------------------------------------------
-- affiliate_conversions
-- ---------------------------------------------------------------------------
CREATE TABLE affiliate_conversions (
    id                          bigserial PRIMARY KEY,
    affiliate_id                uuid NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
    -- The signed-up tenant (nullable for pre-tenant LTD pre-orders, though
    -- usually populated). Not a FK because tenants live in a different
    -- migration ownership chain and we want this table to survive tenant
    -- hard-deletes for accounting.
    tenant_id                   uuid,
    cookie_id                   text NOT NULL,
    kind                        text NOT NULL CHECK (kind IN ('ltd_purchase', 'sending_subscription', 'pro_subscription')),
    amount_cents                bigint NOT NULL,
    commission_cents            bigint NOT NULL,
    commission_rate_pct         numeric(5,2) NOT NULL,
    -- For recurring subscriptions only — tracks the period the conversion
    -- represents so we can avoid double-paying inside one billing cycle.
    recurring_period_end        timestamptz,
    status                      text NOT NULL CHECK (status IN ('pending', 'approved', 'paid', 'reversed', 'disputed')),
    stripe_payment_intent_id    text,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    paid_at                     timestamptz,
    reversed_at                 timestamptz
);

CREATE INDEX affiliate_conversions_affiliate_idx ON affiliate_conversions (affiliate_id, status, created_at DESC);
CREATE INDEX affiliate_conversions_tenant_idx    ON affiliate_conversions (tenant_id);
CREATE UNIQUE INDEX affiliate_conversions_pi_idx ON affiliate_conversions (stripe_payment_intent_id)
    WHERE stripe_payment_intent_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON affiliate_conversions TO postwave_app;
GRANT USAGE ON SEQUENCE affiliate_conversions_id_seq TO postwave_app;

-- ---------------------------------------------------------------------------
-- affiliate_payouts
-- ---------------------------------------------------------------------------
CREATE TABLE affiliate_payouts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    affiliate_id        uuid NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
    amount_cents        bigint NOT NULL,
    currency            text NOT NULL DEFAULT 'USD',
    payout_method       text CHECK (payout_method IN ('paypal', 'wise', 'stripe_connect')),
    -- External transfer ID returned by PayPal / Wise / Stripe Connect.
    payout_reference    text,
    status              text NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
    sent_at             timestamptz,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX affiliate_payouts_affiliate_idx ON affiliate_payouts (affiliate_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON affiliate_payouts TO postwave_app;

COMMIT;
