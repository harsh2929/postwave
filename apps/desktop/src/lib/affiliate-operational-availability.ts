/**
 * Affiliate-program release boundaries.
 *
 * The affiliate ledger is platform-global while desktop identity is
 * workspace-scoped. Public enrollment, click attribution, commercial terms,
 * commission accrual, and settlement are also coupled financial operations.
 * None may be exposed until the whole authority and evidence chain is
 * qualified together.
 */
export const AFFILIATE_ADMIN_INSPECTION_AVAILABLE = false;
export const AFFILIATE_ADMIN_MUTATIONS_AVAILABLE = false;
export const AFFILIATE_PUBLIC_OFFER_AVAILABLE = false;
export const AFFILIATE_ATTRIBUTION_ACCRUAL_AVAILABLE = false;
export const AFFILIATE_PAYOUT_OPERATIONS_AVAILABLE = false;

export const AFFILIATE_ADMIN_INSPECTION_UNAVAILABLE_REASON =
  "Affiliate records are platform-global, while the current desktop role is workspace-scoped. Historical records remain hidden until a dedicated platform-operator authority and audited read contract exist.";

export const AFFILIATE_PUBLIC_OFFER_UNAVAILABLE_REASON =
  "Applications and tracking remain closed until versioned program terms, regional privacy consent, cookie isolation, abuse controls, and production routing are approved.";

export const AFFILIATE_ATTRIBUTION_ACCRUAL_UNAVAILABLE_REASON =
  "New commission accrual remains closed until attribution identity, consent, rate-version snapshots, currency, reversals, and replay-safe ledger invariants are release-qualified.";

export const AFFILIATE_PAYOUT_OPERATIONS_UNAVAILABLE_REASON =
  "Payouts remain closed until approved-only eligibility, immutable previews, expected-set confirmation, dual control, tax readiness, idempotent settlement, reconciliation, and actor evidence are complete.";
