-- F04 direct-attribution evidence completeness.
--
-- `linked_without_recorded_assignment_click` is an observation made at the
-- instant a code redemption is recorded. Reconstructing it later is unsound:
-- a click can arrive late, be retained for a different period, or be removed.
-- Historical rows therefore remain NULL (evidence unavailable) while every
-- new coderedemption write stores the observation atomically with the money
-- event. The campaign evidence register exposes NULL rather than inventing a
-- historical answer.
--
-- migration-execution: phased
-- rollback-strategy: no-op; a nullable evidence fact is safe to retain.

SET lock_timeout = '5s';
SET statement_timeout = '2min';

ALTER TABLE public.discount_redemptions
  ADD COLUMN IF NOT EXISTS linked_without_recorded_assignment_click boolean;

COMMENT ON COLUMN public.discount_redemptions.linked_without_recorded_assignment_click IS
  'F04 event-time observation: whether the issued-to assignment had no recorded campaign click when redemption arrived. NULL means unavailable, not false; never reader or redeemer identity.';

CREATE INDEX CONCURRENTLY IF NOT EXISTS coupon_assignments_campaign_evidence_idx
  ON public.coupon_assignments (tenant_id, campaign_id, assigned_at DESC, id DESC)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS coupon_pools_campaign_evidence_idx
  ON public.coupon_pools (tenant_id, campaign_id, id)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_vanity_visits_evidence_idx
  ON public.campaign_vanity_visits (tenant_id, campaign_id, occurred_at DESC, id DESC);

RESET statement_timeout;
RESET lock_timeout;
