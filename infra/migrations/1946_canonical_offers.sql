-- Canonical offer objects (PRD F15).
--
-- The in-email OfferContent block is not this. That block lives inside one
-- campaign's semantic tree, has a document-scoped node id, and carries no price,
-- no type, no inventory and no stable identity — it describes how an offer is
-- PRESENTED in one message. An agent resolving a CTA needs the offer ITSELF:
-- addressable by a URL that outlives the campaign, answering "what is offered,
-- at what price, until when, and how do I act" without parsing HTML.
--
-- One canonical model, three projections (PRD §17.1): JSON-LD in the email
-- (F08), a human-readable CTA, and this machine-resolvable endpoint. Keeping the
-- model protocol-agnostic is also the one standing obligation F16 leaves behind
-- — inventory_state and action_url are shaped so a feed exporter can map them
-- rather than around any particular provider's payload.
--
-- rollback-strategy: no-op

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE IF NOT EXISTS offers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Nullable: an offer can outlive the campaign that first promoted it, and an
    -- evergreen offer promoted by six campaigns should not need six rows.
    campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,

    type        text NOT NULL CHECK (type IN ('discount', 'event', 'product', 'subscription', 'content')),
    title       text NOT NULL,
    description text NOT NULL DEFAULT '',

    -- Money as integer minor units plus an explicit currency. A float price is
    -- wrong for money and a price with no currency is not a price.
    price_cents   bigint,
    currency      text,
    discount_pct  numeric(5,2) CHECK (discount_pct IS NULL OR (discount_pct > 0 AND discount_pct <= 100)),

    valid_from  timestamptz,
    -- valid_until is what stops a stale agent acting on an expired offer, which
    -- is the specific failure the PRD calls out. It is separate from the
    -- cache-control policy: one tells a cache when to re-ask, the other tells a
    -- reasoner when the answer stopped being true.
    valid_until timestamptz,

    terms_url  text NOT NULL DEFAULT '',
    action_url text NOT NULL DEFAULT '',

    -- Deliberately a small closed vocabulary rather than a provider's status
    -- string: an agent has to decide whether acting is possible, and
    -- 'in_stock' | 'limited' | 'sold_out' | 'unknown' is the least it can be
    -- told. 'unknown' exists because a missing inventory feed must not read as
    -- 'in_stock'.
    inventory_state text NOT NULL DEFAULT 'unknown'
        CHECK (inventory_state IN ('in_stock', 'limited', 'sold_out', 'unknown')),

    metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    -- A price without a currency cannot be acted on, and a currency without a
    -- price is noise. Enforced in the schema because the endpoint's whole
    -- contract is that the JSON is sufficient to decide what is offered.
    CONSTRAINT offers_price_currency_together
        CHECK ((price_cents IS NULL) = (currency IS NULL)),
    -- An offer valid until before it is valid from can never be acted on.
    CONSTRAINT offers_validity_ordered
        CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until)
);

CREATE INDEX IF NOT EXISTS offers_tenant_campaign_idx
    ON offers (tenant_id, campaign_id)
    WHERE campaign_id IS NOT NULL;

-- Live-offer listing, the common read.
CREATE INDEX IF NOT EXISTS offers_tenant_live_idx
    ON offers (tenant_id, valid_until DESC NULLS FIRST);

ALTER TABLE offers ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'offers'
           AND policyname = 'tenant_isolation'
    ) THEN
        CREATE POLICY tenant_isolation ON offers
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON offers TO postwave_app;
