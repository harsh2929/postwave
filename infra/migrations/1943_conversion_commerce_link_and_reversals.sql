-- The missing key, and the money-outcome state machine it unblocks.
--
-- Refunds and disputes have been ARRIVING for as long as the commerce
-- connectors have existed: Stripe ingests `refunds` and `disputes` as
-- first-class object types, Razorpay handles four refund events, Shopify maps
-- `refunded` / `partially_refunded`. They land in commerce_events. Nothing ever
-- reversed the revenue, because a refund and the conversion it reverses shared
-- no identifier — commerce did not create conversions at all, so revenue
-- credited to a campaign stayed credited after the money was handed back.
--
-- The fix is not a reversal table on its own. A reversal table with nothing able
-- to write it is the phantom this schema keeps accumulating. It is the KEY
-- first: conversions.commerce_order_id, so an order's revenue and that order's
-- refund can find each other.
--
-- rollback-strategy: no-op

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE conversions
    ADD COLUMN IF NOT EXISTS commerce_order_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'conversions'::regclass
           AND conname = 'conversions_commerce_order_id_fkey'
    ) THEN
        ALTER TABLE conversions
            ADD CONSTRAINT conversions_commerce_order_id_fkey
            FOREIGN KEY (commerce_order_id) REFERENCES commerce_orders(id)
            ON DELETE SET NULL NOT VALID;
    END IF;
END
$$;

ALTER TABLE conversions VALIDATE CONSTRAINT conversions_commerce_order_id_fkey;

-- ONE conversion per order. This is the load-bearing constraint of the whole
-- ingestion path: upsertOrder runs on every webhook redelivery and on every
-- backfill pass, so without it a provider retrying an order six times would
-- report six times the revenue. Partial, because conversions that did not come
-- from commerce legitimately share a NULL here.
CREATE UNIQUE INDEX IF NOT EXISTS conversions_commerce_order_uniq
    ON conversions (tenant_id, commerce_order_id)
    WHERE commerce_order_id IS NOT NULL;

-- conversion_reversals: money given back, as EVENTS rather than a mutated
-- amount.
--
-- The conversion's amount_cents is deliberately never edited by a refund. A
-- partial refund, a second partial refund and a dispute are three facts with
-- three dates, and overwriting one number would destroy the sequence that makes
-- them explicable — "this order was refunded twice and then disputed" is the
-- answer somebody eventually needs, and it cannot be reconstructed from a
-- decremented total. Gross and reversed are reported separately for the same
-- reason.
CREATE TABLE IF NOT EXISTS conversion_reversals (
    id            bigserial PRIMARY KEY,
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    conversion_id bigint NOT NULL REFERENCES conversions(id) ON DELETE CASCADE,
    -- 'refund' is the merchant giving money back; 'dispute' is the customer
    -- taking it back through the network; 'chargeback' is a dispute the
    -- merchant lost. They are separated because they mean different things
    -- about the customer relationship, and a single "reversed" bucket would
    -- make a healthy refund policy indistinguishable from fraud.
    kind          text NOT NULL CHECK (kind IN ('refund', 'dispute', 'chargeback')),
    amount_cents  bigint,
    currency      text,
    occurred_at   timestamptz NOT NULL DEFAULT now(),
    -- source + external_ref make redelivery idempotent. A provider that sends
    -- the same refund webhook twice must not reverse the money twice.
    source        text NOT NULL DEFAULT 'commerce',
    external_ref  text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS conversion_reversals_source_ref_uniq
    ON conversion_reversals (tenant_id, source, external_ref);

CREATE INDEX IF NOT EXISTS conversion_reversals_conversion_idx
    ON conversion_reversals (tenant_id, conversion_id, occurred_at DESC);

ALTER TABLE conversion_reversals ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'conversion_reversals'
           AND policyname = 'tenant_isolation'
    ) THEN
        CREATE POLICY tenant_isolation ON conversion_reversals
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON conversion_reversals TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE conversion_reversals_id_seq TO postwave_app;
