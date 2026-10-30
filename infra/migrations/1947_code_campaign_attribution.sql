-- Unique codes and direct-nav attribution (PRD F04).
--
-- The PRD's acceptance criterion is one sentence: "a redemption with no preceding
-- click event still attributes to the campaign." It exists because under AI
-- mediation the population that reads a message and then goes to the site
-- directly grows — they never click, so last-touch attribution never sees them,
-- and the campaign that caused the purchase gets no credit.
--
-- That criterion had NO REPRESENTATION in the schema. Not "was not computed":
-- there is no campaign_id on coupon_pools, coupon_assignments,
-- discount_redemptions or landing_pages, so nothing in the database could record
-- which campaign issued a code, and no query could have answered it.
--
-- rollback-strategy: no-op

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- The campaign that ISSUED a code to a recipient.
--
-- This is the load-bearing column: a per-recipient code is the strongest
-- attribution signal in the product, because possession of the code IS the
-- evidence that this person received that campaign.
ALTER TABLE coupon_assignments
    ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL;

-- The campaign a POOL was created for, when codes are per-campaign rather than
-- per-recipient. Lower attribution precision, much lower friction.
ALTER TABLE coupon_pools
    ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL;

-- Denormalised onto the redemption itself, and deliberately not read through a
-- join at report time.
--
-- A redemption is a MONEY EVENT: it must keep its attribution even if the
-- assignment row is later pruned by retention, the pool is deleted, or the code
-- is reissued. Resolving the campaign at read time through two joins would make
-- historical revenue credit depend on rows nobody promised to keep.
ALTER TABLE discount_redemptions
    ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS assignment_id uuid REFERENCES coupon_assignments(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS code text,
    -- Where the redemption was reported from: the customer's commerce system via
    -- the redeem webhook, or an internal path.
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'internal';

-- Vanity landing paths (/go/spring-sale) so direct navigation to a
-- campaign-specific path is attributable without a click on the email.
ALTER TABLE landing_pages
    ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS coupon_assignments_campaign_idx
    ON coupon_assignments (tenant_id, campaign_id)
    WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS discount_redemptions_campaign_idx
    ON discount_redemptions (tenant_id, campaign_id)
    WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS landing_pages_campaign_idx
    ON landing_pages (tenant_id, campaign_id)
    WHERE campaign_id IS NOT NULL;

-- Redemption idempotency. The redeem webhook is called by the customer's
-- commerce system, which will retry.
CREATE UNIQUE INDEX IF NOT EXISTS discount_redemptions_assignment_uniq
    ON discount_redemptions (tenant_id, assignment_id)
    WHERE assignment_id IS NOT NULL;

-- `code_redemption` joins the attribution vocabulary.
--
-- A distinct value rather than reusing `explicit`, because the two are different
-- claims about different evidence: `explicit` means a caller asserted a campaign
-- id, `code_redemption` means the recipient presented a code only that campaign
-- issued them. The second is stronger and a report should be able to say so.
DO $$
BEGIN
    ALTER TABLE conversions DROP CONSTRAINT IF EXISTS conversions_attributed_via_check;
    ALTER TABLE conversions
        ADD CONSTRAINT conversions_attributed_via_check
        CHECK (attributed_via = ANY (ARRAY[
            'explicit'::text, 'last_touch'::text, 'none'::text, 'code_redemption'::text
        ])) NOT VALID;
END
$$;

ALTER TABLE conversions VALIDATE CONSTRAINT conversions_attributed_via_check;
