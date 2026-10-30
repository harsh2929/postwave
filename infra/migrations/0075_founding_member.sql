-- 0042_founding_member.sql
--
-- Native paid-subscription mirror table. The existing SDK resource POSTs to
-- /api/v1/paid-subs but no Postwave-side row was being persisted; this
-- migration introduces the table and the Sprint X3 columns:
--   * billing_interval ("month"|"year") for annual billing
--   * founding_member  boolean tier flag
--   * extra_amount_cents above-floor contribution
--
-- The table is additive — older code paths that ignored it continue to work.

BEGIN;

CREATE TABLE paid_subs (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_email        citext NOT NULL,
    plan_id                 text NOT NULL,
    status                  text NOT NULL DEFAULT 'trialing'
                            CHECK (status IN ('trialing','active','past_due','canceled')),
    billing_interval        text NOT NULL DEFAULT 'month'
                            CHECK (billing_interval IN ('month','year')),
    founding_member         boolean NOT NULL DEFAULT false,
    extra_amount_cents      integer NOT NULL DEFAULT 0 CHECK (extra_amount_cents >= 0),
    discount_code           text,
    trial_ends_at           timestamptz,
    current_period_end      timestamptz,
    stripe_subscription_id  text,
    stripe_customer_id      text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, subscriber_email, plan_id)
);

CREATE INDEX paid_subs_tenant_idx ON paid_subs (tenant_id, status);
CREATE INDEX paid_subs_email_idx  ON paid_subs (tenant_id, subscriber_email);

CREATE TRIGGER paid_subs_set_updated_at
    BEFORE UPDATE ON paid_subs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE ON paid_subs TO postwave_app;

ALTER TABLE paid_subs ENABLE ROW LEVEL SECURITY;
ALTER TABLE paid_subs FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON paid_subs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
