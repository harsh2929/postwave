/**
 * Referrals activation boundaries.
 *
 * Only authenticated historical program, conversion-report, and leaderboard
 * inspection is currently qualified. Program writes, subscriber-link
 * issuance, payout reads/actions, live attribution, and public installation
 * are coupled to incomplete runtime contracts and remain fail-closed.
 */
export const REFERRAL_PUBLIC_WIDGET_INSTALL_AVAILABLE = false;
export const REFERRAL_ATTRIBUTION_RUNTIME_AVAILABLE = false;
export const REFERRAL_PROGRAM_MUTATIONS_AVAILABLE = false;
export const REFERRAL_PAYOUT_OPERATIONS_AVAILABLE = false;
export const REFERRAL_SUBSCRIBER_LINKS_AVAILABLE = false;

export const REFERRAL_PUBLIC_WIDGET_INSTALL_UNAVAILABLE_REASON =
  "Website installation is review-gated until subscriber-code templating, content-security-policy compatibility, accessible widget behavior, public-origin routing, and production delivery evidence are complete.";

export const REFERRAL_ATTRIBUTION_RUNTIME_UNAVAILABLE_REASON =
  "Live attribution is review-gated because signup and form completion do not yet consume referral credit, and program expiry is not enforced across redirect, credit, sharing, congratulations, and reward processing.";

export const REFERRAL_PROGRAM_MUTATIONS_UNAVAILABLE_REASON =
  "Program creation and changes are review-gated until the live attribution path, expiry enforcement, versioned reward snapshots, and stale-write protection are release-qualified.";

export const REFERRAL_PAYOUT_OPERATIONS_UNAVAILABLE_REASON =
  "The reward queue is review-gated because its current read path derives records, applies today's program retroactively, and lacks immutable program, value, actor, and fulfillment evidence.";

export const REFERRAL_SUBSCRIBER_LINKS_UNAVAILABLE_REASON =
  "Subscriber referral links are review-gated because the current read endpoint can mint a live attribution token and does not provide a read-only inspection contract.";
