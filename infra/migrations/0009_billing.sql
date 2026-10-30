-- 0009_billing.sql
--
-- Stripe billing mirror. The `billing_events` table is an append-only log of
-- every webhook event we have observed, keyed by Stripe's `evt_…` ID so that
-- redelivered webhooks become idempotent no-ops. The `billing_state` table is
-- the projection used by the rest of the application — one row per tenant,
-- representing "what does Stripe think this customer's subscription looks
-- like right now?".
--
-- WHY: Stripe is the source of truth for billing. We mirror just enough state
-- locally to (a) gate feature access at request time without an HTTP hop and
-- (b) detect tier changes and trigger our provisioner.
--
-- Both tables FORCE row-level security. `billing_events` is keyed by tenant
-- (nullable for events that arrive before we know the tenant — those are
-- visible only to admins via direct DB access).

BEGIN;

CREATE TABLE billing_events (
    id              text PRIMARY KEY,                 -- Stripe event id (evt_…) for dedup
    tenant_id       uuid REFERENCES tenants(id) ON DELETE SET NULL,
    type            text NOT NULL,                    -- e.g. customer.subscription.updated
	    received_at     timestamptz NOT NULL DEFAULT now(),
	    payload         jsonb NOT NULL,
	    processing_started_at timestamptz,
	    processed_at    timestamptz,
	    error           text
	);

CREATE INDEX billing_events_tenant_idx ON billing_events (tenant_id, received_at DESC);
CREATE INDEX billing_events_type_idx   ON billing_events (type, received_at DESC);
CREATE INDEX billing_events_unprocessed_idx
    ON billing_events (received_at)
    WHERE processed_at IS NULL;
CREATE INDEX billing_events_processing_idx
    ON billing_events (processing_started_at)
    WHERE processed_at IS NULL AND processing_started_at IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON billing_events TO postwave_app;

ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events FORCE  ROW LEVEL SECURITY;

-- Allow inserts when no tenant context is set (webhooks land before we have
-- resolved a tenant); otherwise restrict to the tenant in scope.
CREATE POLICY billing_events_isolation ON billing_events
    FOR ALL
    USING (
        tenant_id IS NULL
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id IS NULL
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE TABLE billing_state (
    tenant_id               uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    stripe_customer_id      text UNIQUE,
    stripe_subscription_id  text,
    tier                    text CHECK (tier IN ('studio', 'sending', 'pro')),
    current_period_end      timestamptz,
    cancel_at               timestamptz,
    dunning                 boolean NOT NULL DEFAULT false,
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX billing_state_dunning_idx
    ON billing_state (tenant_id) WHERE dunning = true;

CREATE TRIGGER billing_state_set_updated_at
    BEFORE UPDATE ON billing_state
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON billing_state TO postwave_app;

ALTER TABLE billing_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_state FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON billing_state
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Verified Stripe webhook handlers occasionally need to resolve a tenant from
-- a Stripe customer id before the event carries tenant metadata. Keep that
-- cross-tenant lookup behind a single SECURITY DEFINER function instead of an
-- app-settable RLS flag.
CREATE OR REPLACE FUNCTION billing_tenant_by_customer(p_customer_id text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT tenant_id
      FROM billing_state
     WHERE stripe_customer_id = p_customer_id
     LIMIT 1
$$;

REVOKE ALL ON FUNCTION billing_tenant_by_customer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_tenant_by_customer(text) TO postwave_app;

COMMIT;
