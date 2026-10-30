-- BILL-052 — metered send overage.
--
-- Two pieces: (A) a per-tenant overage PREFERENCE on billing_state (opt-in +
-- an optional spend ceiling), and (B) a per-tenant, per-month ledger that
-- accrues billable overage units and tracks what has been reported to Stripe.
--
-- Design intent: the feature ships DARK. When overage is off (default) the
-- existing hard cap (a 402 at campaign enqueue) is unchanged. When on, sending
-- above the included allowance is allowed and the overage units are metered.
-- Actual Stripe charging is config-gated (STRIPE_SECRET_KEY + a captured
-- metered subscription item) so self-host / password-only / pre-launch tenants
-- only ever accrue locally (stripe_status = 'local_only').

BEGIN;

-- (A) Preference columns on the existing billing_state tenant table. RLS +
-- grants already cover the table, so new columns need nothing extra.
--   overage_enabled        — the user's opt-in toggle.
--   overage_cap            — optional ceiling on billable overage UNITS per
--                            period (NULL = uncapped; distinct from 0 = none).
--   stripe_overage_item_id — the metered subscription-item id (si_...) captured
--                            from the Stripe webhook; NULL until a metered price
--                            is on the subscription.
ALTER TABLE billing_state
    ADD COLUMN overage_enabled        boolean NOT NULL DEFAULT false,
    ADD COLUMN overage_cap            integer,
    ADD COLUMN stripe_overage_item_id text;

-- (B) The monthly overage ledger. New tenant table → needs the tenants FK,
-- RLS, grants, and an updated_at trigger.
CREATE TABLE send_overage_ledger (
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    period_start       date NOT NULL,                       -- date_trunc('month', now())
    billable_overage   integer NOT NULL DEFAULT 0,          -- max(0, current_usage - included_cap)
    reported_quantity  integer NOT NULL DEFAULT 0,          -- last cumulative qty reported to Stripe
    reported_at        timestamptz,
    stripe_status      text NOT NULL DEFAULT 'local_only',  -- local_only | reported | error
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, period_start),
    CONSTRAINT send_overage_ledger_status_check
        CHECK (stripe_status IN ('local_only', 'reported', 'error'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON send_overage_ledger TO postwave_app;

ALTER TABLE send_overage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_overage_ledger FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON send_overage_ledger
    USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The periodic reconciler runs under a worker scope (no tenant GUC), so it
-- needs an explicit escape to read/write every tenant's ledger row.
CREATE POLICY overage_worker_all ON send_overage_ledger
    USING      (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

CREATE TRIGGER send_overage_ledger_set_updated_at
    BEFORE UPDATE ON send_overage_ledger
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
