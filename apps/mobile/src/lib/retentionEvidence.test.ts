import { describe, expect, it } from "vitest";

import {
  classifyRetentionFunnel,
  retentionEvidenceLabel,
  trustedAcceptanceRate,
} from "./retentionEvidence";
import type { RetentionFunnelTile } from "./retentionOffers";

const OFFER = { id: "off-1", tierId: "tier-1" };

function tile(overrides: Partial<RetentionFunnelTile> = {}): RetentionFunnelTile {
  return {
    offerId: "off-1",
    tierId: "tier-1",
    shown: 10,
    accepted: 3,
    declined: 4,
    expired: 2,
    ...overrides,
  };
}

describe("classifyRetentionFunnel — desktop contract.ts:574-589 verbatim", () => {
  it("matched when exactly one reconciling tile exists", () => {
    expect(classifyRetentionFunnel(OFFER, [tile()])).toBe("matched");
  });

  it("unavailable when the funnel read did not resolve", () => {
    expect(classifyRetentionFunnel(OFFER, null)).toBe("unavailable");
  });

  it("missing when no tile claims the offer", () => {
    expect(
      classifyRetentionFunnel(OFFER, [tile({ offerId: "off-2" })]),
    ).toBe("missing");
  });

  it("duplicate when more than one tile claims it", () => {
    expect(classifyRetentionFunnel(OFFER, [tile(), tile()])).toBe("duplicate");
  });

  it("tier-mismatch when the tile's tier is not the offer's", () => {
    expect(
      classifyRetentionFunnel(OFFER, [tile({ tierId: "tier-9" })]),
    ).toBe("tier-mismatch");
  });

  it("outcome-excess when outcomes exceed showings", () => {
    expect(
      classifyRetentionFunnel(OFFER, [
        tile({ shown: 5, accepted: 3, declined: 2, expired: 1 }),
      ]),
    ).toBe("outcome-excess");
  });

  it("an exact outcome total is NOT excess — the boundary is strict", () => {
    expect(
      classifyRetentionFunnel(OFFER, [
        tile({ shown: 9, accepted: 3, declined: 4, expired: 2 }),
      ]),
    ).toBe("matched");
  });
});

describe("retentionEvidenceLabel — desktop's copy", () => {
  it("short-circuits to in-progress while the read is pending", () => {
    expect(retentionEvidenceLabel("matched", true)).toBe(
      "Reconciliation in progress",
    );
  });

  it("names each verdict as desktop does", () => {
    expect(retentionEvidenceLabel("matched", false)).toBe("Reconciled counters");
    expect(retentionEvidenceLabel("outcome-excess", false)).toBe(
      "Outcome-count conflict",
    );
    expect(retentionEvidenceLabel("duplicate", false)).toBe(
      "Duplicate funnel records",
    );
    expect(retentionEvidenceLabel("tier-mismatch", false)).toBe("Tier mismatch");
    expect(retentionEvidenceLabel("missing", false)).toBe(
      "Funnel record missing",
    );
    expect(retentionEvidenceLabel("unavailable", false)).toBe(
      "Funnel unavailable",
    );
  });
});

describe("trustedAcceptanceRate", () => {
  it("computes accepted/shown from a matched tile only", () => {
    expect(trustedAcceptanceRate("matched", tile())).toBeCloseTo(0.3);
  });

  it("refuses every non-matched verdict — no confident number about nothing", () => {
    expect(trustedAcceptanceRate("duplicate", tile())).toBeNull();
    expect(trustedAcceptanceRate("tier-mismatch", tile())).toBeNull();
    expect(trustedAcceptanceRate("outcome-excess", tile())).toBeNull();
    expect(trustedAcceptanceRate("missing", null)).toBeNull();
    expect(trustedAcceptanceRate("unavailable", null)).toBeNull();
  });

  it("refuses a zero denominator — never 0% for 'never shown'", () => {
    expect(
      trustedAcceptanceRate(
        "matched",
        tile({ shown: 0, accepted: 0, declined: 0, expired: 0 }),
      ),
    ).toBeNull();
  });
});
