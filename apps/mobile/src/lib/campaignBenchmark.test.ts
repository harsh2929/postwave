import { describe, expect, it } from "vitest";

import {
  benchmarkRowSpoken,
  benchmarkUnavailableSentence,
  metricLabel,
  parseCampaignBenchmark,
  percentileSentence,
  verdictSentence,
} from "@/lib/campaignBenchmark";

/** Shaped exactly like the handler's `response` (campaign_benchmarks.go:78). */
const PAYLOAD = {
  campaign_id: "c1",
  baseline_days: 90,
  baseline_sample_size: 11,
  minimum_sample_size: 5,
  baseline_available: true,
  this: { open_rate: 0.42, click_rate: 0.061, bounce_rate: 0.004 },
  tenant_baseline: { open_rate: 0.36, click_rate: 0.058, bounce_rate: 0.011 },
  metrics: [
    {
      name: "open_rate",
      value: 0.42,
      baseline: 0.36,
      delta: 0.06,
      delta_pct: 16.6,
      percentile: 82,
      verdict: "above",
      available: true,
    },
    {
      name: "bounce_rate",
      value: 0.004,
      baseline: 0.011,
      delta: -0.007,
      delta_pct: -63.6,
      percentile: 12,
      // The server INVERTS the verdict for inverse metrics: a bounce rate 64%
      // BELOW the baseline is reported as "above" (i.e. better).
      verdict: "above",
      available: true,
    },
  ],
};

describe("parseCampaignBenchmark", () => {
  it("reads the envelope and keeps rates as FRACTIONS", () => {
    const benchmark = parseCampaignBenchmark(PAYLOAD);
    expect(benchmark.available).toBe(true);
    expect(benchmark.sampleSize).toBe(11);
    expect(benchmark.metrics).toHaveLength(2);
    // 0.42 is 42%, not 0.42% — this endpoint returns fractions while the
    // campaign report on the same screen returns percentages.
    expect(benchmark.metrics[0]?.value).toBe(0.42);
    expect(benchmark.metrics[0]?.label).toBe("Open rate");
  });

  it("drops an unavailable metric's percentile rather than showing a rank", () => {
    const benchmark = parseCampaignBenchmark({
      baseline_available: false,
      metrics: [
        {
          name: "click_rate",
          value: 0.02,
          baseline: 0,
          available: false,
          reason: "insufficient_baseline_sample",
        },
      ],
    });
    expect(benchmark.metrics[0]?.available).toBe(false);
    expect(benchmark.metrics[0]?.percentile).toBeNull();
    expect(benchmark.metrics[0]?.verdict).toBeNull();
  });

  it("survives a garbage payload", () => {
    expect(parseCampaignBenchmark(null).metrics).toEqual([]);
    expect(parseCampaignBenchmark({ metrics: 4 }).available).toBe(false);
    expect(parseCampaignBenchmark({ metrics: [{ value: 1 }] }).metrics).toEqual(
      [],
    );
  });
});

describe("benchmarkUnavailableSentence", () => {
  it("permits a comparison the server says it can make", () => {
    expect(benchmarkUnavailableSentence(parseCampaignBenchmark(PAYLOAD)))
      .toBeNull();
  });

  it("names how many campaigns short the workspace is", () => {
    const sentence = benchmarkUnavailableSentence(
      parseCampaignBenchmark({
        baseline_days: 90,
        baseline_sample_size: 2,
        minimum_sample_size: 5,
        baseline_available: false,
        metrics: [
          { name: "open_rate", value: 0.4, baseline: 0, available: false },
        ],
      }),
    );
    expect(sentence).toContain("needs 5 finished campaigns");
    expect(sentence).toContain("this workspace has 2");
  });

  it("reports an absent benchmark as absent, not as an empty comparison", () => {
    expect(
      benchmarkUnavailableSentence(parseCampaignBenchmark({})),
    ).toContain("has not reported a benchmark");
  });
});

describe("verdictSentence", () => {
  it("says BETTER, not higher — the server already inverted the polarity", () => {
    const benchmark = parseCampaignBenchmark(PAYLOAD);
    // A bounce rate 64% BELOW baseline arrives as verdict "above". Rendering
    // that word literally would tell the reader bounces went up.
    const bounce = benchmark.metrics[1];
    expect(bounce?.key).toBe("bounce_rate");
    expect(verdictSentence(bounce as never)).toBe(
      "Better than your recent average",
    );
  });

  it("declines to compare a metric the server marked unavailable", () => {
    expect(
      verdictSentence({
        key: "click_rate",
        label: "Click rate",
        value: 0.02,
        baseline: null,
        verdict: null,
        percentile: null,
        available: false,
      }),
    ).toBe("Not enough history to compare");
  });
});

describe("percentileSentence", () => {
  it("states the rank as a fact, never as an accolade", () => {
    const benchmark = parseCampaignBenchmark(PAYLOAD);
    // 12th percentile bounce rate is GOOD, 82nd percentile open rate is GOOD,
    // and the same neutral wording is true of both. "Top 12%" would not be.
    expect(percentileSentence(benchmark.metrics[0] as never)).toBe(
      "Higher than 82% of your recent campaigns",
    );
    expect(percentileSentence(benchmark.metrics[1] as never)).toBe(
      "Higher than 12% of your recent campaigns",
    );
  });

  it("says nothing when there is no rank", () => {
    expect(
      percentileSentence({
        key: "open_rate",
        label: "Open rate",
        value: 0.4,
        baseline: 0.3,
        verdict: null,
        percentile: null,
        available: false,
      }),
    ).toBeNull();
  });
});

describe("benchmarkRowSpoken", () => {
  it("speaks both exact figures and the comparison", () => {
    const spoken = benchmarkRowSpoken(
      parseCampaignBenchmark(PAYLOAD).metrics[0] as never,
    );
    expect(spoken).toContain("Open rate, 42.00 percent against 36.00 percent");
    expect(spoken).toContain("Better than your recent average");
    expect(spoken).toContain("Higher than 82%");
  });

  it("says 'not reported' rather than reading a zero", () => {
    expect(
      benchmarkRowSpoken({
        key: "open_rate",
        label: "Open rate",
        value: null,
        baseline: null,
        verdict: null,
        percentile: null,
        available: false,
      }),
    ).toBe("Open rate, not reported.");
  });
});

describe("metricLabel", () => {
  it("humanises an unknown key instead of printing the snake case", () => {
    expect(metricLabel("spam_trap_rate")).toBe("Spam trap rate");
    expect(metricLabel("unsubscribe_rate")).toBe("Unsubscribe rate");
  });
});
