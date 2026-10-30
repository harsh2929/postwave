// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

import { ApiError } from "@/lib/api";
import {
  askAnalytics,
  composeBroadcast,
  generateSubjectLines,
  getAnomalyBrief,
  getTopPerformingSubjects,
  parseAnalyticsAnswer,
  parseAnomalyBrief,
  parseComposedBroadcast,
  parseSubjectLineScores,
  parseTopPerformingSubjects,
  parseVoiceDriftReading,
} from "@/lib/ai-compose-api";

const CAMPAIGN_ID = "018f0000-0000-7000-8000-000000000001";
const GENERATED_AT = "2026-08-30T10:00:00Z";

function broadcastFixture() {
  return {
    primary: {
      name: "",
      subject: "Ship with confidence",
      body: "<p>Review the release.</p>",
      preview_text: "Release notes",
    },
    subject_variants: ["Ship with confidence", "Review before release"],
    generated_at: GENERATED_AT,
  };
}

function analyticsFixture() {
  return {
    question: "How many subscribers joined?",
    answer_kind: "table",
    template: "subscriber_growth",
    params: { window_days: 7, limit: 10 },
    columns: ["day", "new_subscribers"],
    rows: [
      {
        day: "2026-08-30",
        new_subscribers: 4,
        operator_email: "must-not-survive@example.test",
      },
    ],
    summary_text: "Four subscribers joined.",
    trace: {
      reasoning: "private chain of thought must not enter UI state",
      prompt_tokens: 100,
      response_tokens: 20,
      summary_tokens: 5,
      generated_at: GENERATED_AT,
    },
  };
}

function anomalyFixture() {
  return {
    metric: "opens",
    window_days: 7,
    summary: "Opens increased.",
    probable_causes: ["A recent campaign performed well."],
    suggested_actions: ["Review the top campaign."],
    aggregates: {
      metric: "opens",
      window_days: 7,
      current_total: 7,
      previous_total: 5,
      daily: [
        { day: "2026-08-29", value: 3 },
        { day: "2026-08-30", value: 4 },
      ],
      top_campaigns: [
        {
          campaign_id: CAMPAIGN_ID,
          campaign_name: "Launch",
          value: 4,
        },
      ],
    },
    trace: {
      reasoning: "private",
      prompt_tokens: 50,
      response_tokens: 25,
      summary_tokens: 0,
      generated_at: GENERATED_AT,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AI compose response contracts", () => {
  it("normalizes a server-valid unnamed draft without losing generated copy", () => {
    const parsed = parseComposedBroadcast(broadcastFixture());
    expect(parsed.primary.name).toBe(parsed.primary.subject);
    expect(parsed.subjectVariants).toEqual([
      "Ship with confidence",
      "Review before release",
    ]);
  });

  it("rejects a draft whose A/B choices omit its primary subject", () => {
    const value = broadcastFixture();
    value.subject_variants = ["A different subject"];
    expect(() => parseComposedBroadcast(value)).toThrow(/primary subject/iu);
  });

  it("accepts the score endpoint's intentionally empty axis and rejects bad confidence intervals", () => {
    const score = {
      baseline_open: 0.35,
      window_days: 180,
      variants: [
        {
          text: "Review the release",
          axis: "",
          predicted_open: 0.4,
          ci_low: 0.3,
          ci_high: 0.5,
          matched_n: 8,
          low_confidence: false,
          below_baseline: false,
        },
      ],
    };
    expect(parseSubjectLineScores(score).variants[0]?.axis).toBe("");
    score.variants[0]!.ci_low = 0.45;
    expect(() => parseSubjectLineScores(score)).toThrow(
      /confidence interval/iu,
    );
  });
});

describe("AI analytics evidence contracts", () => {
  it("retains only whitelisted table columns and strips model trace detail", () => {
    const parsed = parseAnalyticsAnswer(analyticsFixture());
    expect(parsed.rows).toEqual([{ day: "2026-08-30", new_subscribers: 4 }]);
    expect(JSON.stringify(parsed)).not.toMatch(
      /operator_email|chain of thought|prompt_tokens/iu,
    );
  });

  it("rejects an unrenderable template identity or missing table cell", () => {
    const invalidTemplate = analyticsFixture();
    invalidTemplate.template = "../../report";
    expect(() => parseAnalyticsAnswer(invalidTemplate)).toThrow(/template/iu);

    const missingCell = analyticsFixture();
    delete (missingCell.rows[0] as Record<string, unknown>).new_subscribers;
    expect(() => parseAnalyticsAnswer(missingCell)).toThrow(/missing/iu);
  });

  it("requires ordered, unique, reconciled server aggregates", () => {
    expect(parseAnomalyBrief(anomalyFixture()).currentTotal).toBe(7);

    const drifted = anomalyFixture();
    drifted.aggregates.current_total = 8;
    expect(() => parseAnomalyBrief(drifted)).toThrow(/reconcile/iu);

    const reversed = anomalyFixture();
    reversed.aggregates.daily.reverse();
    expect(() => parseAnomalyBrief(reversed)).toThrow(/sequence/iu);
  });

  it("requires explicit, coherent currency provenance for revenue", () => {
    const value = anomalyFixture();
    value.metric = "revenue";
    value.aggregates.metric = "revenue";
    expect(() => parseAnomalyBrief(value)).toThrow(/scope is missing/iu);

    const emptyRevenue = {
      ...value,
      aggregates: {
        ...value.aggregates,
        current_total: 0,
        previous_total: 0,
        daily: [],
        top_campaigns: [],
        revenue_scope: {
          currency: null,
          monetary_conversion_count: 0,
          excluded_currency_count: 0,
        },
      },
    };
    expect(parseAnomalyBrief(emptyRevenue).revenueScope).toEqual({
      currency: null,
      monetaryConversionCount: 0,
      excludedCurrencyCount: 0,
    });
  });
});

describe("historical subject and voice contracts", () => {
  it("reconciles top-performer rates and normalizes an empty campaign name", () => {
    const value = {
      window_days: 90,
      min_recipients: 20,
      top: [
        {
          campaign_id: CAMPAIGN_ID,
          name: "",
          subject: "A useful subject",
          sent_at: GENERATED_AT,
          recipients: 100,
          opens: 40,
          clicks: 5,
          open_rate: 0.4,
          click_rate: 0.05,
        },
      ],
    };
    expect(parseTopPerformingSubjects(value).top[0]?.name).toBe(
      "Untitled campaign",
    );
    value.top[0]!.open_rate = 0.5;
    expect(() => parseTopPerformingSubjects(value)).toThrow(/reconcile/iu);
  });

  it("normalizes the deployed voice-service breakdown and retains provenance", () => {
    expect(
      parseVoiceDriftReading({
        score: 72.5,
        severity: "ok",
        breakdown: {
          embedding_similarity: 0.8,
          stylistic_distance: 0.2,
          vocabulary_overlap: 0.7,
          structural_match: 0.6,
          combined: 0.725,
        },
        profile_id: "018f0000-0000-7000-8000-000000000009",
        authored_adjustment: -2,
        suggestions: ["Shorten the introduction."],
      }),
    ).toMatchObject({
      components: { combined: 0.725 },
      profileId: "018f0000-0000-7000-8000-000000000009",
      authoredAdjustment: -2,
    });
  });
});

describe("AI request binding and availability", () => {
  it("trims and bounds compose inputs and uses a fire-once online request", async () => {
    mocks.post.mockResolvedValueOnce(broadcastFixture());
    await composeBroadcast("  Release announcement  ", {
      tone: "  direct  ",
      audience: "  annual subscribers  ",
      variantCount: 2,
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/ai/compose/broadcast",
      {
        brief: "Release announcement",
        tone: "direct",
        audience: "annual subscribers",
        variant_count: 2,
      },
      { requireOnline: true, maxAttempts: 1, timeoutMs: 90_000 },
    );
    expect(() =>
      composeBroadcast("valid brief", { tone: "x".repeat(101) }),
    ).toThrow(/Tone/iu);
  });

  it("sends valid subject, analytics, anomaly, and historical request shapes", async () => {
    const controller = new AbortController();
    mocks.post
      .mockResolvedValueOnce({
        candidates: ["One subject"],
        generated_at: GENERATED_AT,
        fallback: false,
      })
      .mockResolvedValueOnce(analyticsFixture())
      .mockResolvedValueOnce(anomalyFixture());
    mocks.get.mockResolvedValueOnce({
      window_days: 90,
      min_recipients: 20,
      top: [],
    });

    await generateSubjectLines("  Release brief  ", { variantCount: 1 });
    await askAnalytics("  How many joined?  ");
    await getAnomalyBrief({ metric: "opens", windowDays: 7 });
    await getTopPerformingSubjects({ signal: controller.signal });

    expect(mocks.post).toHaveBeenNthCalledWith(
      1,
      "/api/v1/ai/subject-lines/generate",
      { prompt: "Release brief", variant_count: 1 },
      { requireOnline: true, maxAttempts: 1, timeoutMs: 90_000 },
    );
    expect(mocks.post).toHaveBeenNthCalledWith(
      2,
      "/api/v1/analytics/nlq",
      { question: "How many joined?" },
      { requireOnline: true, maxAttempts: 1, timeoutMs: 90_000 },
    );
    expect(mocks.post).toHaveBeenNthCalledWith(
      3,
      "/api/v1/analytics/anomaly-brief",
      { metric: "opens", window_days: 7 },
      { requireOnline: true, maxAttempts: 1, timeoutMs: 90_000 },
    );
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/ai/subject-lines/top-performers",
      {
        query: { days: 90, limit: 8, min_recipients: 20 },
        signal: controller.signal,
      },
    );
  });

  it("returns an explicit unavailable state and does not invent a remedy", async () => {
    mocks.post.mockRejectedValueOnce(
      new ApiError("Unavailable", 503, undefined, {
        code: "voice_unavailable",
      }),
    );
    await expect(generateSubjectLines("Release brief")).resolves.toEqual({
      ok: false,
      unavailable: true,
    });
  });
});
