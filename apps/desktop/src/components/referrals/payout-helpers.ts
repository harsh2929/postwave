/**
 * payout-helpers — pure logic behind PayoutChecklist.tsx, split out so
 * it stays importable from the node-environment vitest suite (the
 * desktop tsconfig keeps `jsx: preserve`, so .tsx modules can't be
 * imported by tests directly).
 */

import type {
  ReferralMilestonePayout,
  ReferralMilestonePayoutStatus,
} from "../../lib/api-client";

export type PayoutFilter = "all" | ReferralMilestonePayoutStatus;

/** Legal next transitions for a payout, mirroring the server's rules
 *  (pending→approved, pending/approved→paid). Offering anything else
 *  guarantees a 409 from PATCH /referrals/payouts/{id}. */
export function payoutActionsFor(
  status: ReferralMilestonePayoutStatus,
): Array<"approved" | "paid"> {
  if (status === "pending") return ["approved", "paid"];
  if (status === "approved") return ["paid"];
  return [];
}

/** Pure status patch used for both the optimistic update and the
 *  error rollback. Targets one row by id; everything else untouched. */
export function applyPayoutStatus(
  items: ReferralMilestonePayout[],
  id: string,
  status: ReferralMilestonePayoutStatus,
): ReferralMilestonePayout[] {
  return items.map((p) => (p.id === id ? { ...p, status } : p));
}

/** Reward labels may carry the legacy "[kind] " prefix the program
 *  editor encodes (see Referrals.tsx) — strip it for display. */
export function stripRewardPrefix(label: string): string {
  return (label ?? "").replace(/^\[[a-z]+\]\s*/, "").trim();
}
