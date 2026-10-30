-- 0041_gift_subscriptions.sql
--
-- Gift subscriptions: a purchaser pays a one-time invoice; on payment the
-- recipient is granted a paid sub for `duration_months`. The Stripe invoice
-- id is stored so the webhook handler can reconcile payment to grant.

BEGIN;

CREATE TABLE gift_subscriptions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    purchaser_email     citext NOT NULL,
    recipient_email     citext NOT NULL,
    plan_id             text NOT NULL,
    duration_months     smallint NOT NULL CHECK (duration_months BETWEEN 1 AND 60),
    message             text,
    status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','paid','granted','refunded','canceled')),
    stripe_invoice_id   text,
    stripe_payment_url  text,
    granted_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX gift_subscriptions_tenant_idx ON gift_subscriptions (tenant_id, status);
CREATE INDEX gift_subscriptions_recipient_idx ON gift_subscriptions (tenant_id, recipient_email);

GRANT SELECT, INSERT, UPDATE ON gift_subscriptions TO postwave_app;

ALTER TABLE gift_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_subscriptions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON gift_subscriptions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
