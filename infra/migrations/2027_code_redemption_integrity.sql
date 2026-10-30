-- F04 code-redemption integrity and tenant ownership.
--
-- A redemption is a money fact. Code-only lookup must be index-bounded and
-- ambiguity must fail closed; every relationship used to assign campaign
-- credit must prove tenant ownership in PostgreSQL, not merely rely on RLS.
-- The explicit conversions.code_assignment_id is the durable one-to-one join
-- from attributed revenue back to the allocation receipt. It is not reader
-- identity and must never be interpreted as such.
--
-- migration-execution: phased
-- rollback-strategy: no-op; evidence links and ownership constraints are
-- retained for receipts already issued.

ALTER TABLE conversions
  ADD COLUMN IF NOT EXISTS code_assignment_id uuid;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS discounts_tenant_id_id_uidx
  ON discounts (tenant_id, id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS coupon_pools_tenant_id_id_uidx
  ON coupon_pools (tenant_id, id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS coupon_codes_tenant_id_id_uidx
  ON coupon_codes (tenant_id, id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS coupon_assignments_tenant_id_id_uidx
  ON coupon_assignments (tenant_id, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS coupon_assignments_tenant_static_code_idx
  ON coupon_assignments (tenant_id, static_code, id)
  WHERE static_code <> '';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS conversions_code_assignment_uidx
  ON conversions (tenant_id, code_assignment_id)
  WHERE code_assignment_id IS NOT NULL;

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'coupon_pools'::regclass
       AND conname = 'coupon_pools_discount_tenant_fk'
  ) THEN
    ALTER TABLE coupon_pools
      ADD CONSTRAINT coupon_pools_discount_tenant_fk
      FOREIGN KEY (tenant_id, discount_id)
      REFERENCES discounts (tenant_id, id)
      ON DELETE SET NULL (discount_id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'coupon_codes'::regclass
       AND conname = 'coupon_codes_pool_tenant_fk'
  ) THEN
    ALTER TABLE coupon_codes
      ADD CONSTRAINT coupon_codes_pool_tenant_fk
      FOREIGN KEY (tenant_id, pool_id)
      REFERENCES coupon_pools (tenant_id, id)
      ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'coupon_codes'::regclass
       AND conname = 'coupon_codes_subscriber_tenant_fk'
  ) THEN
    ALTER TABLE coupon_codes
      ADD CONSTRAINT coupon_codes_subscriber_tenant_fk
      FOREIGN KEY (tenant_id, subscriber_id)
      REFERENCES subscribers (tenant_id, id)
      ON DELETE SET NULL (subscriber_id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'coupon_assignments'::regclass
       AND conname = 'coupon_assignments_pool_tenant_fk'
  ) THEN
    ALTER TABLE coupon_assignments
      ADD CONSTRAINT coupon_assignments_pool_tenant_fk
      FOREIGN KEY (tenant_id, pool_id)
      REFERENCES coupon_pools (tenant_id, id)
      ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'coupon_assignments'::regclass
       AND conname = 'coupon_assignments_code_tenant_fk'
  ) THEN
    ALTER TABLE coupon_assignments
      ADD CONSTRAINT coupon_assignments_code_tenant_fk
      FOREIGN KEY (tenant_id, code_id)
      REFERENCES coupon_codes (tenant_id, id)
      ON DELETE SET NULL (code_id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'coupon_assignments'::regclass
       AND conname = 'coupon_assignments_subscriber_tenant_fk'
  ) THEN
    ALTER TABLE coupon_assignments
      ADD CONSTRAINT coupon_assignments_subscriber_tenant_fk
      FOREIGN KEY (tenant_id, subscriber_id)
      REFERENCES subscribers (tenant_id, id)
      ON DELETE SET NULL (subscriber_id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'coupon_assignments'::regclass
       AND conname = 'coupon_assignments_campaign_tenant_fk'
  ) THEN
    ALTER TABLE coupon_assignments
      ADD CONSTRAINT coupon_assignments_campaign_tenant_fk
      FOREIGN KEY (tenant_id, campaign_id)
      REFERENCES campaigns (tenant_id, id)
      ON DELETE SET NULL (campaign_id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'discount_redemptions'::regclass
       AND conname = 'discount_redemptions_discount_tenant_fk'
  ) THEN
    ALTER TABLE discount_redemptions
      ADD CONSTRAINT discount_redemptions_discount_tenant_fk
      FOREIGN KEY (tenant_id, discount_id)
      REFERENCES discounts (tenant_id, id)
      ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'discount_redemptions'::regclass
       AND conname = 'discount_redemptions_subscriber_tenant_fk'
  ) THEN
    ALTER TABLE discount_redemptions
      ADD CONSTRAINT discount_redemptions_subscriber_tenant_fk
      FOREIGN KEY (tenant_id, subscriber_id)
      REFERENCES subscribers (tenant_id, id)
      ON DELETE SET NULL (subscriber_id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'discount_redemptions'::regclass
       AND conname = 'discount_redemptions_campaign_tenant_fk'
  ) THEN
    ALTER TABLE discount_redemptions
      ADD CONSTRAINT discount_redemptions_campaign_tenant_fk
      FOREIGN KEY (tenant_id, campaign_id)
      REFERENCES campaigns (tenant_id, id)
      ON DELETE SET NULL (campaign_id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'discount_redemptions'::regclass
       AND conname = 'discount_redemptions_assignment_tenant_fk'
  ) THEN
    ALTER TABLE discount_redemptions
      ADD CONSTRAINT discount_redemptions_assignment_tenant_fk
      FOREIGN KEY (tenant_id, assignment_id)
      REFERENCES coupon_assignments (tenant_id, id)
      ON DELETE SET NULL (assignment_id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'landing_pages'::regclass
       AND conname = 'landing_pages_campaign_tenant_fk'
  ) THEN
    ALTER TABLE landing_pages
      ADD CONSTRAINT landing_pages_campaign_tenant_fk
      FOREIGN KEY (tenant_id, campaign_id)
      REFERENCES campaigns (tenant_id, id)
      ON DELETE SET NULL (campaign_id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'conversions'::regclass
       AND conname = 'conversions_campaign_tenant_fk'
  ) THEN
    ALTER TABLE conversions
      ADD CONSTRAINT conversions_campaign_tenant_fk
      FOREIGN KEY (tenant_id, campaign_id)
      REFERENCES campaigns (tenant_id, id)
      ON DELETE SET NULL (campaign_id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'conversions'::regclass
       AND conname = 'conversions_code_assignment_tenant_fk'
  ) THEN
    ALTER TABLE conversions
      ADD CONSTRAINT conversions_code_assignment_tenant_fk
      FOREIGN KEY (tenant_id, code_assignment_id)
      REFERENCES coupon_assignments (tenant_id, id)
      ON DELETE SET NULL (code_assignment_id) NOT VALID;
  END IF;
END
$$;

DO $$
DECLARE
  mismatches jsonb;
  total bigint;
BEGIN
  SELECT jsonb_build_object(
    'pool_discount', (SELECT count(*) FROM coupon_pools c LEFT JOIN discounts p ON p.id=c.discount_id AND p.tenant_id=c.tenant_id WHERE c.discount_id IS NOT NULL AND p.id IS NULL),
    'code_pool', (SELECT count(*) FROM coupon_codes c LEFT JOIN coupon_pools p ON p.id=c.pool_id AND p.tenant_id=c.tenant_id WHERE p.id IS NULL),
    'code_subscriber', (SELECT count(*) FROM coupon_codes c LEFT JOIN subscribers p ON p.id=c.subscriber_id AND p.tenant_id=c.tenant_id WHERE c.subscriber_id IS NOT NULL AND p.id IS NULL),
    'assignment_pool', (SELECT count(*) FROM coupon_assignments c LEFT JOIN coupon_pools p ON p.id=c.pool_id AND p.tenant_id=c.tenant_id WHERE p.id IS NULL),
    'assignment_code', (SELECT count(*) FROM coupon_assignments c LEFT JOIN coupon_codes p ON p.id=c.code_id AND p.tenant_id=c.tenant_id WHERE c.code_id IS NOT NULL AND p.id IS NULL),
    'assignment_subscriber', (SELECT count(*) FROM coupon_assignments c LEFT JOIN subscribers p ON p.id=c.subscriber_id AND p.tenant_id=c.tenant_id WHERE c.subscriber_id IS NOT NULL AND p.id IS NULL),
    'assignment_campaign', (SELECT count(*) FROM coupon_assignments c LEFT JOIN campaigns p ON p.id=c.campaign_id AND p.tenant_id=c.tenant_id WHERE c.campaign_id IS NOT NULL AND p.id IS NULL),
    'redemption_discount', (SELECT count(*) FROM discount_redemptions c LEFT JOIN discounts p ON p.id=c.discount_id AND p.tenant_id=c.tenant_id WHERE p.id IS NULL),
    'redemption_subscriber', (SELECT count(*) FROM discount_redemptions c LEFT JOIN subscribers p ON p.id=c.subscriber_id AND p.tenant_id=c.tenant_id WHERE c.subscriber_id IS NOT NULL AND p.id IS NULL),
    'redemption_campaign', (SELECT count(*) FROM discount_redemptions c LEFT JOIN campaigns p ON p.id=c.campaign_id AND p.tenant_id=c.tenant_id WHERE c.campaign_id IS NOT NULL AND p.id IS NULL),
    'redemption_assignment', (SELECT count(*) FROM discount_redemptions c LEFT JOIN coupon_assignments p ON p.id=c.assignment_id AND p.tenant_id=c.tenant_id WHERE c.assignment_id IS NOT NULL AND p.id IS NULL),
    'landing_campaign', (SELECT count(*) FROM landing_pages c LEFT JOIN campaigns p ON p.id=c.campaign_id AND p.tenant_id=c.tenant_id WHERE c.campaign_id IS NOT NULL AND p.id IS NULL),
    'conversion_campaign', (SELECT count(*) FROM conversions c LEFT JOIN campaigns p ON p.id=c.campaign_id AND p.tenant_id=c.tenant_id WHERE c.campaign_id IS NOT NULL AND p.id IS NULL),
    'conversion_assignment', (SELECT count(*) FROM conversions c LEFT JOIN coupon_assignments p ON p.id=c.code_assignment_id AND p.tenant_id=c.tenant_id WHERE c.code_assignment_id IS NOT NULL AND p.id IS NULL)
  ) INTO mismatches;
  SELECT coalesce(sum(value::text::bigint), 0)
    INTO total FROM jsonb_each(mismatches);
  IF total > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = 'F04 tenant-reference preflight failed',
      DETAIL = mismatches::text || '; reconcile ownership without copying code or subscriber payloads, then retry migration 2027';
  END IF;
END
$$;

ALTER TABLE coupon_pools VALIDATE CONSTRAINT coupon_pools_discount_tenant_fk;
ALTER TABLE coupon_codes VALIDATE CONSTRAINT coupon_codes_pool_tenant_fk;
ALTER TABLE coupon_codes VALIDATE CONSTRAINT coupon_codes_subscriber_tenant_fk;
ALTER TABLE coupon_assignments VALIDATE CONSTRAINT coupon_assignments_pool_tenant_fk;
ALTER TABLE coupon_assignments VALIDATE CONSTRAINT coupon_assignments_code_tenant_fk;
ALTER TABLE coupon_assignments VALIDATE CONSTRAINT coupon_assignments_subscriber_tenant_fk;
ALTER TABLE coupon_assignments VALIDATE CONSTRAINT coupon_assignments_campaign_tenant_fk;
ALTER TABLE discount_redemptions VALIDATE CONSTRAINT discount_redemptions_discount_tenant_fk;
ALTER TABLE discount_redemptions VALIDATE CONSTRAINT discount_redemptions_subscriber_tenant_fk;
ALTER TABLE discount_redemptions VALIDATE CONSTRAINT discount_redemptions_campaign_tenant_fk;
ALTER TABLE discount_redemptions VALIDATE CONSTRAINT discount_redemptions_assignment_tenant_fk;
ALTER TABLE landing_pages VALIDATE CONSTRAINT landing_pages_campaign_tenant_fk;
ALTER TABLE conversions VALIDATE CONSTRAINT conversions_campaign_tenant_fk;
ALTER TABLE conversions VALIDATE CONSTRAINT conversions_code_assignment_tenant_fk;

ALTER TABLE conversions
  DROP CONSTRAINT IF EXISTS conversions_code_assignment_provenance_ck,
  ADD CONSTRAINT conversions_code_assignment_provenance_ck
    CHECK (code_assignment_id IS NULL OR attributed_via = 'code_redemption') NOT VALID;
ALTER TABLE conversions VALIDATE CONSTRAINT conversions_code_assignment_provenance_ck;

-- The composite constraints now subsume the old id-only relationships. Remove
-- them so deletes execute one unambiguous action and future schema inspection
-- cannot mistake the weaker constraint for the ownership boundary.
ALTER TABLE coupon_pools DROP CONSTRAINT IF EXISTS coupon_pools_discount_id_fkey;
ALTER TABLE coupon_codes DROP CONSTRAINT IF EXISTS coupon_codes_pool_id_fkey;
ALTER TABLE coupon_assignments DROP CONSTRAINT IF EXISTS coupon_assignments_pool_id_fkey;
ALTER TABLE coupon_assignments DROP CONSTRAINT IF EXISTS coupon_assignments_code_id_fkey;
ALTER TABLE coupon_assignments DROP CONSTRAINT IF EXISTS coupon_assignments_campaign_id_fkey;
ALTER TABLE discount_redemptions DROP CONSTRAINT IF EXISTS discount_redemptions_discount_id_fkey;
ALTER TABLE discount_redemptions DROP CONSTRAINT IF EXISTS discount_redemptions_campaign_id_fkey;
ALTER TABLE discount_redemptions DROP CONSTRAINT IF EXISTS discount_redemptions_assignment_id_fkey;
ALTER TABLE landing_pages DROP CONSTRAINT IF EXISTS landing_pages_campaign_id_fkey;
ALTER TABLE conversions DROP CONSTRAINT IF EXISTS conversions_campaign_id_fkey;

COMMENT ON COLUMN conversions.code_assignment_id IS
  'F04 allocation receipt that linked this outcome to a campaign; never proof of redeemer or reader identity.';

COMMIT;
