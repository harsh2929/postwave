-- 2061_provider_neutral_billing.sql
--
-- Dodo Payments is Moosewave's canonical collection provider. Preserve the
-- old Stripe columns for rollback and historical readers, while moving active
-- projections and customer lookup to provider-neutral columns.
--
-- migration-execution: phased
-- rollback-strategy: no-op
-- rollback-details: Additive compatibility columns may be left in place if an
-- application rollback temporarily resumes the legacy Stripe projection.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE billing_state
    ADD COLUMN IF NOT EXISTS provider text,
    ADD COLUMN IF NOT EXISTS customer_id text,
    ADD COLUMN IF NOT EXISTS subscription_id text;

ALTER TABLE billing_state
    DROP CONSTRAINT IF EXISTS billing_state_provider_check;

ALTER TABLE billing_state
    ADD CONSTRAINT billing_state_provider_check
    CHECK (provider IS NULL OR provider IN ('dodo', 'stripe'));

UPDATE billing_state
   SET provider = COALESCE(provider, 'stripe'),
       customer_id = COALESCE(customer_id, stripe_customer_id),
       subscription_id = COALESCE(subscription_id, stripe_subscription_id)
 WHERE stripe_customer_id IS NOT NULL
    OR stripe_subscription_id IS NOT NULL;

COMMIT;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS billing_state_provider_customer_uidx
    ON billing_state (provider, customer_id)
    WHERE provider IS NOT NULL AND customer_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS billing_state_provider_subscription_idx
    ON billing_state (provider, subscription_id)
    WHERE provider IS NOT NULL AND subscription_id IS NOT NULL;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION billing_tenant_by_provider_customer(
    p_provider text,
    p_customer_id text
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT tenant_id
      FROM billing_state
     WHERE provider = p_provider
       AND customer_id = p_customer_id
     LIMIT 1
$$;

REVOKE ALL ON FUNCTION billing_tenant_by_provider_customer(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_tenant_by_provider_customer(text, text) TO postwave_app;

COMMENT ON COLUMN billing_state.provider IS
    'Canonical collection provider for customer_id/subscription_id. Dodo is used by Moosewave; stripe remains valid for migrated historical rows.';
COMMENT ON COLUMN billing_state.customer_id IS
    'Provider-owned customer identifier, interpreted together with provider.';
COMMENT ON COLUMN billing_state.subscription_id IS
    'Provider-owned active subscription identifier, interpreted together with provider.';

COMMIT;
