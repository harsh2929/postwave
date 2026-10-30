// Tests for the A/B results display contract. The actual results card
// is a React component that consumes ABResultsResponse from
// lib/ab-results-api.ts; the math + winner gating live server-side. We pin the
// shape of the response and the display-side gating rules here:
//
//   - frequentist tab shows z, p, lift
//   - bayesian tab shows P(B>A) + credible interval
//   - winner banner gates on confidence > 0.95
//   - Bonferroni-corrected toggle changes which `significant_*` flag is
//     authoritative
//
// Each test exercises the helpers we'd use in the React component if
// it were testable with a DOM — we keep them here as pure functions
// so the regression surface is locked in.

import { describe, expect, it } from "vitest";

import type {
  ABBayesianOutcome,
  ABFrequentistOutcome,
  ABResultsResponse,
} from "@/lib/ab-results-api";

const sampleResults: ABResultsResponse = {
  campaign_id: "camp_demo",
  metric: "open_rate",
  variants: [
    {
      id: "var_a",
      variant_index: 0,
      variant_label: "A",
      subject: "Five things",
      sent: 1000,
      hits: 412,
      rate: 0.412,
      is_control: true,
    },
    {
      id: "var_b",
      variant_index: 1,
      variant_label: "B",
      subject: "Recap",
      sent: 1000,
      hits: 478,
      rate: 0.478,
      is_control: false,
    },
  ],
  frequentist: {
    "0_vs_1": {
      z_score: 3.02,
      p_value: 0.0025,
      lift_percent: 16.0,
      significant_at_95: true,
      significant_after_correction: true,
    },
  },
  bayesian: {
    "0_vs_1": {
      prob_b_better: 0.987,
      expected_lift: 0.066,
      credible_interval_95: [0.012, 0.121],
    },
  },
  bonferroni: {
    num_comparisons: 1,
    family_alpha: 0.05,
    corrected_alpha: 0.05,
    applied_to_frequentist: true,
  },
  winner: {
    variant_index: 1,
    variant_id: "var_b",
    method: "bayesian",
    confidence: 0.987,
  },
};

/** Display label for the frequentist tab. */
function formatFrequentist(f: ABFrequentistOutcome): string {
  return `z=${f.z_score.toFixed(2)} · p=${f.p_value.toFixed(4)} · lift=${f.lift_percent.toFixed(1)}%`;
}

/** Display label for the bayesian tab. */
function formatBayesian(b: ABBayesianOutcome): string {
  const [lo, hi] = b.credible_interval_95;
  return `P(B>A)=${(b.prob_b_better * 100).toFixed(1)}% · CI95=[${lo.toFixed(3)}, ${hi.toFixed(3)}]`;
}

/** Mirrors the winner-banner gating used by the React component. */
function shouldShowWinnerBanner(r: ABResultsResponse): boolean {
  if (!r.winner) return false;
  if (r.winner.method === "not_decided") return false;
  return r.winner.confidence > 0.95;
}

/** Resolves which flag is authoritative once the toggle is set. */
function isSignificant(
  f: ABFrequentistOutcome,
  withBonferroni: boolean,
): boolean {
  return withBonferroni ? f.significant_after_correction : f.significant_at_95;
}

describe("A/B results — frequentist tab", () => {
  it("shows z-score, p-value, and lift", () => {
    const out = formatFrequentist(sampleResults.frequentist["0_vs_1"]);
    expect(out).toContain("z=3.02");
    expect(out).toContain("p=0.0025");
    expect(out).toContain("lift=16.0%");
  });
});

describe("A/B results — bayesian tab", () => {
  it("shows P(B>A) percent + the 95% credible interval", () => {
    const out = formatBayesian(sampleResults.bayesian["0_vs_1"]);
    expect(out).toContain("P(B>A)=98.7%");
    expect(out).toContain("CI95=[0.012, 0.121]");
  });
});

describe("A/B results — winner banner gating", () => {
  it("appears when confidence > 0.95", () => {
    expect(shouldShowWinnerBanner(sampleResults)).toBe(true);
  });

  it("hides when confidence is at or below 0.95", () => {
    const r: ABResultsResponse = {
      ...sampleResults,
      winner: { ...sampleResults.winner!, confidence: 0.95 },
    };
    expect(shouldShowWinnerBanner(r)).toBe(false);
  });

  it("hides when no winner is decided", () => {
    const r: ABResultsResponse = {
      ...sampleResults,
      winner: {
        variant_index: -1,
        method: "not_decided",
        confidence: 0,
      },
    };
    expect(shouldShowWinnerBanner(r)).toBe(false);
  });
});

describe("A/B results — Bonferroni toggle", () => {
  it("uses uncorrected flag when toggle is off", () => {
    const f: ABFrequentistOutcome = {
      z_score: 2.0,
      p_value: 0.045,
      lift_percent: 8.0,
      significant_at_95: true,
      significant_after_correction: false,
    };
    expect(isSignificant(f, false)).toBe(true);
  });

  it("uses corrected flag when toggle is on (and may flip the verdict)", () => {
    const f: ABFrequentistOutcome = {
      z_score: 2.0,
      p_value: 0.045,
      lift_percent: 8.0,
      significant_at_95: true,
      significant_after_correction: false,
    };
    expect(isSignificant(f, true)).toBe(false);
  });
});
