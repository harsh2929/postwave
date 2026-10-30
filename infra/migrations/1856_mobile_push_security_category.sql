-- 1856_mobile_push_security_category.sql
-- migration-execution: phased
-- rollback-strategy: no-op
-- rollback-details: The widened CHECK is compatible with older API images,
-- which continue writing only 'approval' and 'entity'. A schema rollback that
-- re-narrows the constraint must first map any retained 'security' delivery
-- evidence to 'entity'; an application rollback requires no data change.
--
-- Native auth.new_device_sign_in notifications use a dedicated iOS category
-- and Android channel. mobile_push_deliveries persists that category before
-- calling Expo, so its historical approval|entity CHECK must be widened or the
-- security notification fails closed at the delivery ledger.

-- Install and name-swap the replacement atomically. This block is deliberately
-- resumable across every phase an earlier execution can leave behind:
--
--   * only the historical narrow canonical constraint exists;
--   * both the narrow canonical constraint and staged _v2 exist;
--   * only staged _v2 exists;
--   * the canonical constraint is already broad, validated or NOT VALID.
--
-- Rebuilding a stranded _v2 inside this transaction is safe: the historical
-- canonical constraint remains authoritative until the commit. NOT VALID
-- avoids a table scan while still enforcing the broader rule for new writes.
DO $migration$
DECLARE
    canonical_supports_security boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'mobile_push_deliveries'::regclass
           AND conname = 'mobile_push_deliveries_category_check'
           AND contype = 'c'
           AND strpos(pg_get_constraintdef(oid), '''security''') > 0
    ) INTO canonical_supports_security;

    IF canonical_supports_security THEN
        -- A prior run completed the swap. Remove only a redundant staging
        -- constraint, which would otherwise continue restricting writes if it
        -- came from an interrupted/manual attempt with the old definition.
        ALTER TABLE mobile_push_deliveries
            DROP CONSTRAINT IF EXISTS mobile_push_deliveries_category_check_v2;
    ELSE
        -- Whether _v2 is absent, correct, or stale, rebuilding it gives the
        -- remainder of this transaction one known definition.
        ALTER TABLE mobile_push_deliveries
            DROP CONSTRAINT IF EXISTS mobile_push_deliveries_category_check_v2;

        ALTER TABLE mobile_push_deliveries
            ADD CONSTRAINT mobile_push_deliveries_category_check_v2
            CHECK (category_id IN ('approval', 'security', 'entity')) NOT VALID;

        ALTER TABLE mobile_push_deliveries
            DROP CONSTRAINT IF EXISTS mobile_push_deliveries_category_check;

        ALTER TABLE mobile_push_deliveries
            RENAME CONSTRAINT mobile_push_deliveries_category_check_v2
            TO mobile_push_deliveries_category_check;
    END IF;
END
$migration$;

-- Validation takes a weaker lock and can scan existing rows after the short
-- constraint-name swap has committed.
ALTER TABLE mobile_push_deliveries
    VALIDATE CONSTRAINT mobile_push_deliveries_category_check;
