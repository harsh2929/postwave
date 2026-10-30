-- 2066_canonical_moosewave_billing_tiers.sql
-- Admit the Moosewave Sandbox/Launch/Growth/Scale catalog while retaining the
-- old tier values as read-only compatibility for existing rows.
--
-- migration-execution: transactional
-- rollback-strategy: no-op
-- rollback-details: New tier values may be referenced by subscription and
-- allowance evidence after deployment. Removing them would make rollback less
-- safe than leaving the expanded constraints in place.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_tier_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_tier_check
  CHECK (tier IN ('sandbox','launch','growth','scale','studio','sending','pro'));

ALTER TABLE billing_state DROP CONSTRAINT IF EXISTS billing_state_tier_check;
ALTER TABLE billing_state ADD CONSTRAINT billing_state_tier_check
  CHECK (tier IN ('sandbox','launch','growth','scale','studio','sending','pro'));

ALTER TABLE sending_state DROP CONSTRAINT IF EXISTS sending_state_tier_check;
ALTER TABLE sending_state ADD CONSTRAINT sending_state_tier_check
  CHECK (tier IN ('sandbox','launch','growth','scale','studio','sending','pro'));

COMMIT;
