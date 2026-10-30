/**
 * payout-checklist — pure logic behind the referral payout fulfilment
 * queue (Referrals page, desktop audit follow-up):
 *
 *   1. payoutActionsFor — per-status action gating must mirror the
 *      server's legal transitions (pending→approved, pending/approved
 *      →paid). Offering an illegal action guarantees a 409.
 *   2. applyPayoutStatus — the optimistic-update patch is also the
 *      rollback path, so it must be a pure, id-targeted map that
 *      leaves every other row untouched.
 *   3. stripRewardPrefix — reward labels may carry the legacy
 *      "[kind] " prefix the program editor encodes; the queue strips
 *      it for display without mangling plain labels.
 */

import { describe, expect, it } from "vitest";

import {
  applyPayoutStatus,
  payoutActionsFor,
  stripRewardPrefix,
} from "../../components/referrals/payout-helpers";
import type { ReferralMilestonePayout } from "../../lib/api-client";

function row(
  id: string,
  status: ReferralMilestonePayout["status"],
): ReferralMilestonePayout {
  return {
    id,
    referrer_id: `sub_${id}`,
    milestone: 10,
    reward_label: "1 month free",
    status,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
  };
}

describe("payoutActionsFor", () => {
  it("pending can be approved or marked paid directly", () => {
    expect(payoutActionsFor("pending")).toEqual(["approved", "paid"]);
  });

  it("approved can only be marked paid", () => {
    expect(payoutActionsFor("approved")).toEqual(["paid"]);
  });

  it("paid is terminal — no actions", () => {
    expect(payoutActionsFor("paid")).toEqual([]);
  });
});

describe("applyPayoutStatus", () => {
  it("patches only the targeted row", () => {
    const items = [row("a", "pending"), row("b", "pending")];
    const next = applyPayoutStatus(items, "a", "approved");
    expect(next.find((p) => p.id === "a")?.status).toBe("approved");
    expect(next.find((p) => p.id === "b")?.status).toBe("pending");
  });

  it("is pure — the input array and rows are not mutated", () => {
    const items = [row("a", "pending")];
    const next = applyPayoutStatus(items, "a", "paid");
    expect(items[0]?.status).toBe("pending");
    expect(next[0]).not.toBe(items[0]);
  });

  it("round-trips as the rollback path (optimistic → revert)", () => {
    const items = [row("a", "pending"), row("b", "approved")];
    const optimistic = applyPayoutStatus(items, "b", "paid");
    const rolledBack = applyPayoutStatus(optimistic, "b", "approved");
    expect(rolledBack).toEqual(items);
  });

  it("unknown id is a no-op", () => {
    const items = [row("a", "pending")];
    expect(applyPayoutStatus(items, "nope", "paid")).toEqual(items);
  });
});

describe("stripRewardPrefix", () => {
  it("strips the legacy [kind] prefix", () => {
    expect(stripRewardPrefix("[swag] Branded hoodie")).toBe("Branded hoodie");
    expect(stripRewardPrefix("[free] 1 month free")).toBe("1 month free");
  });

  it("leaves plain labels untouched", () => {
    expect(stripRewardPrefix("Annual subscription")).toBe(
      "Annual subscription",
    );
  });

  it("doesn't strip prefixes mid-string or uppercase brackets", () => {
    expect(stripRewardPrefix("Reward [swag] inside")).toBe(
      "Reward [swag] inside",
    );
    expect(stripRewardPrefix("[SWAG] hoodie")).toBe("[SWAG] hoodie");
  });
});
