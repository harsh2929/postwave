// SPDX-License-Identifier: AGPL-3.0-only
//
// Neutral test data for the campaign A/B editor. Mirrors the mocks pattern
// used by forms-mocks.ts and inbox-reality-mocks.ts: deterministic, lightly
// realistic, never references real customers.

import type {
  ABSettings,
  ABView,
  Variant,
  VariantResult,
} from "./abtests-types";

const SEED_VARIANTS: Variant[] = [
  {
    id: "var_a",
    campaign_id: "camp_demo",
    variant_label: "A",
    subject: "Five things we learned this quarter",
    from_name: "The Demo Team",
    body_mjml:
      "<mjml><mj-body><mj-section><mj-column><mj-text>Hey there — five quick lessons from this quarter…</mj-text></mj-column></mj-section></mj-body></mjml>",
    weight: 50,
    created_at: "2026-04-29T10:00:00Z",
  },
  {
    id: "var_b",
    campaign_id: "camp_demo",
    variant_label: "B",
    subject: "Quarterly recap (with one weird chart)",
    from_name: "The Demo Team",
    body_mjml:
      "<mjml><mj-body><mj-section><mj-column><mj-text>Hey — recap below. Note the weird chart in the middle.</mj-text></mj-column></mj-section></mj-body></mjml>",
    weight: 50,
    created_at: "2026-04-29T10:00:00Z",
  },
];

const SEED_RESULTS: VariantResult[] = [
  {
    variant_id: "var_a",
    recipients_count: 1000,
    delivered: 985,
    opens: 412,
    clicks: 73,
    unsubscribes: 4,
    complaints: 0,
    winner: false,
  },
  {
    variant_id: "var_b",
    recipients_count: 1000,
    delivered: 982,
    opens: 478,
    clicks: 96,
    unsubscribes: 3,
    complaints: 1,
    winner: true,
  },
];

const SEED_SETTINGS: ABSettings = {
  campaign_id: "camp_demo",
  winner_metric: "open_rate",
  evaluation_window_hours: 24,
  winner_recipients_pct: 100,
	 sample_pct: 100,
	 bandit_strategy: "fixed",
	 explore_floor: 0.1,
	 recompute_interval_minutes: 30,
};

// Campaign creation and the A/B editor are separate lazy-loaded mock modules.
// Keep the bridge here, keyed by the canonical parent id, so opening a test
// created from the campaign dialog shows its actual subjects instead of the
// unrelated canned demo experiment.
const createdABViews = new Map<string, ABView>();

export function mockRegisterCreatedABTest(
  campaignID: string,
  variants: Variant[],
): void {
  createdABViews.set(campaignID, {
    settings: {
      campaign_id: campaignID,
      winner_metric: "open_rate",
      evaluation_window_hours: 24,
      winner_recipients_pct: 100,
      sample_pct: 100,
      bandit_strategy: "fixed",
      explore_floor: 0.1,
      recompute_interval_minutes: 30,
    },
    variants,
    results: [],
    winner_variant_id: null,
  });
}

function preserveCampaignSignature(campaignID: string): string {
  return campaignID;
}

export function mockGetAB(campaignID: string): ABView {
  const created = createdABViews.get(campaignID);
  if (created) return created;
  preserveCampaignSignature(campaignID);
  return {
    settings: SEED_SETTINGS,
    variants: SEED_VARIANTS,
    results: SEED_RESULTS,
    winner_variant_id: "var_b",
  };
}

export function mockListVariants(campaignID: string): Variant[] {
  const created = createdABViews.get(campaignID);
  if (created) return created.variants;
  preserveCampaignSignature(campaignID);
  return SEED_VARIANTS;
}

export function mockSetSettings(
  campaignID: string,
  patch: Partial<ABSettings>,
): ABSettings {
  const created = createdABViews.get(campaignID);
  if (!created) {
    preserveCampaignSignature(campaignID);
    return { ...SEED_SETTINGS, ...patch };
  }
  const settings = { ...created.settings, ...patch, campaign_id: campaignID };
  createdABViews.set(campaignID, { ...created, settings });
  return settings;
}

export function mockCreateVariants(
  campaignID: string,
  variants: Variant[],
): Variant[] {
  preserveCampaignSignature(campaignID);
  const createdVariants = variants.map((v, i) => ({
    ...v,
    id: v.id ?? `var_mock_${i}`,
    campaign_id: campaignID,
    created_at: new Date().toISOString(),
  }));
  const created = createdABViews.get(campaignID);
  if (created) {
    createdABViews.set(campaignID, {
      ...created,
      variants: createdVariants,
    });
  }
  return createdVariants;
}

export function mockEvaluate(campaignID: string): ABView {
  const created = createdABViews.get(campaignID);
  if (created) return created;
  preserveCampaignSignature(campaignID);
  return {
    settings: SEED_SETTINGS,
    variants: SEED_VARIANTS,
    results: SEED_RESULTS,
    winner_variant_id: "var_b",
  };
}

// Deterministic A/B statistical report so the Results page renders in the
// demo/preview build instead of 500-ing on the real backend (CAMP-004).
export function mockABResults(campaignID: string, metric: string) {
  const rateFor = (hits: number, sent: number) => (sent > 0 ? hits / sent : 0);
  const aSent = 1000;
  const bSent = 1000;
  const aHits = metric === "click_rate" ? 73 : metric === "reply_rate" ? 12 : 412;
  const bHits = metric === "click_rate" ? 96 : metric === "reply_rate" ? 19 : 478;
  return {
    campaign_id: campaignID,
    metric,
    variants: [
      {
        id: "var_a",
        variant_index: 0,
        variant_label: "A",
        subject: "Five things we learned this quarter",
        sent: aSent,
        hits: aHits,
        rate: rateFor(aHits, aSent),
        is_control: true,
      },
      {
        id: "var_b",
        variant_index: 1,
        variant_label: "B",
        subject: "Quarterly recap (with one weird chart)",
        sent: bSent,
        hits: bHits,
        rate: rateFor(bHits, bSent),
        is_control: false,
      },
    ],
    frequentist: {
      "1_vs_0": {
        z_score: 2.41,
        p_value: 0.016,
        lift_percent: 16.0,
        significant_at_95: true,
        significant_after_correction: true,
      },
    },
    bayesian: {
      "1_vs_0": {
        prob_b_better: 0.982,
        expected_lift: 0.066,
        credible_interval_95: [0.012, 0.121] as [number, number],
      },
    },
    bonferroni: {
      num_comparisons: 1,
      family_alpha: 0.05,
      corrected_alpha: 0.05,
      applied_to_frequentist: false,
    },
    winner: {
      variant_index: 1,
      variant_id: "var_b",
      method: "bayesian" as const,
      confidence: 0.982,
    },
  };
}

export function mockABWeightHistory(campaignID: string) {
  const base = Date.parse("2026-04-29T10:00:00Z");
  const step = 30 * 60_000;
  const points = (weights: number[]) =>
    weights.map((weight, i) => ({
      at: new Date(base + i * step).toISOString(),
      weight,
    }));
  return {
    campaign_id: campaignID,
    series: [
      { variant_id: "var_a", label: "A", points: points([50, 46, 41, 38, 35]) },
      { variant_id: "var_b", label: "B", points: points([50, 54, 59, 62, 65]) },
    ],
  };
}
