import { describe, expect, it } from "vitest";

import {
  clvConfidenceLine,
  clvMajorUnits,
  clvUnavailableReason,
  parseClvSummary,
} from "@/lib/clvSummary";

/** Shaped exactly like `CLVDistribution` (predictive/repo.go:144). */
const PAYLOAD = {
  profile_count: 5000,
  scored_profiles: 1200,
  total_clv_cents: 900000000,
  predicted_clv_cents: 300000000,
  avg_total_clv_cents: 180000,
  percentiles: {
    p10_cents: 0,
    p25_cents: 1500,
    p50_cents: 4200,
    p75_cents: 19000,
    p90_cents: 88000,
    p99_cents: 410000,
  },
  tiers: [
    { key: "champions", label: "Champions", profiles: 500, avg_total_clv_cents: 250000, avg_churn_risk: 0.1 },
    { key: "at_risk", label: "At risk", profiles: 340, avg_total_clv_cents: 120000, avg_churn_risk: 0.78 },
  ],
  top_profiles: [{ email: "whale@example.com", total_clv_cents: 900000 }],
  at_risk_profiles: [{ email: "leaving@example.com", churn_risk: 0.9 }],
  last_calculated_at: "2026-07-20T09:00:00Z",
};

describe("parseClvSummary", () => {
  it("reads the two phone-sized figures and the at-risk band", () => {
    const summary = parseClvSummary(PAYLOAD);
    expect(summary.medianTotalCents).toBe(4200);
    expect(summary.p90TotalCents).toBe(88000);
    expect(summary.atRiskProfiles).toBe(340);
    expect(summary.atRiskAvgCents).toBe(120000);
    expect(summary.lastCalculatedAt).toBe("2026-07-20T09:00:00Z");
  });

  it("never surfaces the named customer previews", () => {
    // top_profiles / at_risk_profiles are arrays of email addresses. Nothing
    // this module returns can carry one, so no screen can render one by
    // accident and nothing can persist one to the offline vault.
    const summary = parseClvSummary(PAYLOAD);
    expect(JSON.stringify(summary)).not.toContain("@example.com");
    expect(Object.keys(summary)).not.toContain("topProfiles");
    expect(Object.keys(summary)).not.toContain("atRiskProfiles_preview");
  });

  it("keeps an absent figure null rather than zero", () => {
    const summary = parseClvSummary({ profile_count: 10 });
    expect(summary.medianTotalCents).toBeNull();
    expect(summary.atRiskProfiles).toBeNull();
    expect(summary.scoredProfiles).toBeNull();
  });

  it("survives a garbage payload", () => {
    expect(parseClvSummary(null).profileCount).toBeNull();
    expect(parseClvSummary("nope").medianTotalCents).toBeNull();
    expect(parseClvSummary({ tiers: 5 }).atRiskProfiles).toBeNull();
  });

  it("ignores a tier band that is not at_risk", () => {
    const summary = parseClvSummary({
      profile_count: 3,
      tiers: [{ key: "champions", profiles: 3, avg_total_clv_cents: 10 }],
    });
    expect(summary.atRiskProfiles).toBeNull();
  });
});

describe("clvMajorUnits", () => {
  it("converts the payload's cents and preserves null", () => {
    expect(clvMajorUnits(4200)).toBe(42);
    expect(clvMajorUnits(null)).toBeNull();
  });
});

describe("clvUnavailableReason", () => {
  it("permits a snapshot with real values", () => {
    expect(clvUnavailableReason(parseClvSummary(PAYLOAD))).toBeNull();
  });

  it("distinguishes 'never computed' from 'computed and worth nothing'", () => {
    expect(
      clvUnavailableReason(parseClvSummary({ profile_count: 0 })),
    ).toContain("have been computed");
    expect(
      clvUnavailableReason(
        parseClvSummary({
          profile_count: 900,
          percentiles: { p50_cents: 0, p90_cents: 0 },
        }),
      ),
    ).toContain("paid commerce orders");
  });

  it("refuses a snapshot with no distribution at all", () => {
    expect(
      clvUnavailableReason(parseClvSummary({ profile_count: 4 })),
    ).toContain("value distribution was not reported");
  });

  it("refuses a payload that reported no profile count", () => {
    expect(clvUnavailableReason(parseClvSummary(null))).toContain(
      "not reported a customer-value snapshot",
    );
  });
});

describe("clvConfidenceLine", () => {
  it("discloses the scored share, not just the row count", () => {
    expect(clvConfidenceLine(parseClvSummary(PAYLOAD))).toBe(
      "Across 5000 profiles; 1200 (24%) have enough order history to score confidently.",
    );
  });

  it("says nothing extra when everything is scored", () => {
    expect(
      clvConfidenceLine(
        parseClvSummary({ profile_count: 10, scored_profiles: 10 }),
      ),
    ).toBe("Across 10 scored profiles.");
  });

  it("stays silent when the share is unknown", () => {
    expect(clvConfidenceLine(parseClvSummary({ profile_count: 10 }))).toBeNull();
    expect(clvConfidenceLine(parseClvSummary({ profile_count: 0 }))).toBeNull();
  });
});
