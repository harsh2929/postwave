import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CampaignABResultsModal,
  winnerFrequentistOutcome,
} from "../../components/campaigns/CampaignABResultsModal";
import type { ABResultsResponse, Campaign } from "../../lib/api-client";

describe("campaign A/B results extraction", () => {
  it("resolves the winner by the backend comparison key, not map order", () => {
    const results = response();
    results.frequentist = {
      control_vs_unrelated: {
        z_score: 0,
        p_value: 1,
        lift_percent: 0,
        significant_at_95: false,
        significant_after_correction: false,
      },
      control_vs_challenger: {
        z_score: 2.7,
        p_value: 0.007,
        lift_percent: 18.5,
        significant_at_95: true,
        significant_after_correction: true,
      },
    };

    expect(winnerFrequentistOutcome(results)?.lift_percent).toBe(18.5);
    expect(
      winnerFrequentistOutcome({ ...results, winner: undefined }),
    ).toBeUndefined();
  });

  it("renders winner, metric, Bayesian evidence, and close controls", () => {
    const html = renderToStaticMarkup(
      <CampaignABResultsModal
        campaign={{ id: "campaign-1", name: "Launch" } as Campaign}
        metric="open_rate"
        onMetricChange={() => undefined}
        data={response()}
        weightHistory={[]}
        loading={false}
        error={null}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("A/B Results — Launch");
    expect(html).toContain("Open rate");
    expect(html).toContain("challenger");
    expect(html).toContain("P(B&gt;A)");
    expect(html).toContain("Why these stats?");
    expect(html).toContain("Close");
  });

  it("keeps loading and failure states explicit", () => {
    const html = renderToStaticMarkup(
      <CampaignABResultsModal
        campaign={{ id: "campaign-1", name: "Launch" } as Campaign}
        metric="click_rate"
        onMetricChange={() => undefined}
        data={null}
        weightHistory={[]}
        loading
        error="provider unavailable"
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("Loading…");
    expect(html).toContain("Couldn&#x27;t load results: provider unavailable");
  });
});

function response(): ABResultsResponse {
  return {
    campaign_id: "campaign-1",
    metric: "open_rate",
    variants: [
      {
        id: "variant-a",
        variant_index: 0,
        variant_label: "control",
        sent: 100,
        hits: 30,
        rate: 0.3,
        is_control: true,
      },
      {
        id: "variant-b",
        variant_index: 1,
        variant_label: "challenger",
        sent: 100,
        hits: 36,
        rate: 0.36,
        is_control: false,
      },
    ],
    frequentist: {
      control_vs_challenger: {
        z_score: 2.1,
        p_value: 0.035,
        lift_percent: 20,
        significant_at_95: true,
        significant_after_correction: true,
      },
    },
    bayesian: {
      control_vs_challenger: {
        prob_b_better: 0.96,
        expected_lift: 0.2,
        credible_interval_95: [0.02, 0.35],
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
      variant_id: "variant-b",
      method: "frequentist",
      confidence: 0.965,
    },
  };
}
