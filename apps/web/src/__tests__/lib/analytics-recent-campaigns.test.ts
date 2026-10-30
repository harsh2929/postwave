// SPDX-License-Identifier: AGPL-3.0-only
//
// The view-model behind the Analytics campaign-derived panels — the web port
// of desktop useAnalyticsDashboardViewModel's buildEngagementSeries /
// buildFunnelRows / buildCampaignChartEvidence / buildMailClientSlices and the
// controller's per-campaign fan-in. Expectations are hand-computed from the
// fixtures, never derived from the functions under test.

import { describe, expect, it } from "vitest";

import {
  aggregateBounces,
  aggregateDevices,
  aggregateGeography,
  aggregateLinks,
  alignSparklineToDates,
  benchmarkVerdictMetrics,
  buildBounceSlices,
  buildCampaignChartEvidence,
  buildEngagementSeries,
  buildFunnelRows,
  buildMailClientSlices,
  engagementTableRows,
  funnelEmailsSent,
  funnelStepConversions,
  linePathOnAxis,
  openableLinkUrl,
  rangeDates,
  recentCampaignName,
} from "@/lib/analytics-recent-campaigns";
import type {
  CampaignBenchmark,
  CampaignReport,
} from "@/lib/campaign-analytics-api";

// 23:30 UTC — local midnight arithmetic east of UTC would name the 10th.
const NOW = new Date("2026-09-11T23:30:00Z");

describe("rangeDates / alignSparklineToDates", () => {
  it("names the last N UTC calendar days, oldest first", () => {
    expect(rangeDates(3, NOW)).toEqual([
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
    ]);
    expect(rangeDates(0, NOW)).toEqual([]);
  });

  it("aligns a sparkline's LAST value to today; a short one covers only the most recent days", () => {
    const dates = ["2026-09-09", "2026-09-10", "2026-09-11"];
    expect(alignSparklineToDates([7, 8], dates)).toEqual([
      { date: "2026-09-10", count: 7 },
      { date: "2026-09-11", count: 8 },
    ]);
    // Longer than the window: keep the most recent values.
    expect(alignSparklineToDates([1, 2, 3, 4, 5], dates)).toEqual([
      { date: "2026-09-09", count: 3 },
      { date: "2026-09-10", count: 4 },
      { date: "2026-09-11", count: 5 },
    ]);
    expect(alignSparklineToDates([], dates)).toEqual([]);
  });
});

describe("buildEngagementSeries", () => {
  it("aligns opens/clicks to the range and passes replies through with their own dates", () => {
    const series = buildEngagementSeries(
      7,
      [1, 2],
      [0, 5, 6],
      [
        { date: "2026-09-10", replies: 3 },
        { date: "2026-09-11", replies: Number.NaN },
      ],
      NOW,
    );
    expect(series.opens).toEqual([
      { date: "2026-09-10", count: 1 },
      { date: "2026-09-11", count: 2 },
    ]);
    expect(series.clicks.map((p) => p.date)).toEqual([
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
    ]);
    expect(series.replies).toEqual([
      { date: "2026-09-10", count: 3 },
      { date: "2026-09-11", count: 0 },
    ]);
  });

  it("treats an absent replies response as no replies line, not zeros", () => {
    expect(buildEngagementSeries(7, [], [], null, NOW).replies).toEqual([]);
  });

  it("tables every date once, with null where a series was not measured", () => {
    const rows = engagementTableRows({
      opens: [{ date: "2026-09-11", count: 4 }],
      clicks: [],
      replies: [
        { date: "2026-09-10", count: 1 },
        { date: "2026-09-11", count: 2 },
      ],
    });
    expect(rows).toEqual([
      { date: "2026-09-10", opens: null, clicks: null, replies: 1 },
      { date: "2026-09-11", opens: 4, clicks: null, replies: 2 },
    ]);
  });

  it("draws a short series over the dates it covers on a shared axis", () => {
    const axis = ["2026-09-09", "2026-09-10", "2026-09-11"];
    const box = { width: 100, height: 50, pad: 5, max: 10 };
    // x = position * 50; y = 5 + (1 - v/10) * 40.
    expect(
      linePathOnAxis(
        [
          { date: "2026-09-10", count: 10 },
          { date: "2026-09-11", count: 0 },
        ],
        axis,
        box,
      ),
    ).toBe("M50.0,5.0 L100.0,45.0");
    // One point on the axis is not a line.
    expect(
      linePathOnAxis([{ date: "2026-09-11", count: 3 }], axis, box),
    ).toBe("");
  });
});

describe("buildFunnelRows", () => {
  it("caps each step by the one before it", () => {
    expect(buildFunnelRows(1000, 40, 1200, 1500)).toEqual([
      { label: "Sent", value: 1000 },
      { label: "Delivered", value: 960 },
      { label: "Opened", value: 960 },
      { label: "Clicked", value: 960 },
    ]);
    expect(buildFunnelRows(1000, 40, 500, 120)).toEqual([
      { label: "Sent", value: 1000 },
      { label: "Delivered", value: 960 },
      { label: "Opened", value: 500 },
      { label: "Clicked", value: 120 },
    ]);
  });

  it("with no send count, every step is zero", () => {
    expect(buildFunnelRows(null, 40, 500, 120).map((r) => r.value)).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it("only a positive send count is a send count", () => {
    expect(funnelEmailsSent(0)).toBeNull();
    expect(funnelEmailsSent(undefined)).toBeNull();
    expect(funnelEmailsSent(Number.NaN)).toBeNull();
    expect(funnelEmailsSent(12)).toBe(12);
  });

  it("converts each step against the previous one, null after an empty step", () => {
    expect(
      funnelStepConversions(buildFunnelRows(1000, 200, 400, 100)),
    ).toEqual([null, 0.8, 0.5, 0.25]);
    expect(funnelStepConversions(buildFunnelRows(100, 100, 5, 5))).toEqual([
      null,
      0,
      null,
      null,
    ]);
  });
});

function report(partial: Partial<CampaignReport>): CampaignReport {
  return {
    sent: 0,
    unique_opens: 0,
    unique_clicks: 0,
    ...partial,
  } as CampaignReport;
}

describe("buildCampaignChartEvidence", () => {
  const campaigns = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ];

  it("keeps campaign order, uses unique counts, and counts the missing reports", () => {
    const evidence = buildCampaignChartEvidence(campaigns, {
      a: report({ sent: 10, unique_opens: 4, unique_clicks: 1 }),
      c: report({ sent: 5, unique_opens: 2, unique_clicks: 0 }),
    });
    expect(evidence.rows).toEqual([
      { id: "a", name: "A", opens: 4, clicks: 1 },
      { id: "c", name: "C", opens: 2, clicks: 0 },
    ]);
    expect(evidence.missingReports).toBe(1);
    expect(evidence.hasData).toBe(true);
  });

  it("all-zero reports are not data", () => {
    const evidence = buildCampaignChartEvidence(campaigns.slice(0, 1), {
      a: report({}),
    });
    expect(evidence.hasData).toBe(false);
    expect(evidence.rows).toHaveLength(1);
  });

  it("falls back from name to subject to Untitled", () => {
    expect(recentCampaignName({ name: "  ", subject: "Hello" })).toBe("Hello");
    expect(recentCampaignName({ name: null, subject: null })).toBe("Untitled");
  });
});

function benchmark(partial: Partial<CampaignBenchmark>): CampaignBenchmark {
  return {
    baseline_available: true,
    baseline_sample_size: 10,
    minimum_sample_size: 5,
    metrics: [],
    ...partial,
  } as CampaignBenchmark;
}

const METRIC = {
  value: 0,
  baseline: 0,
  delta: 0,
  delta_pct: 1,
  percentile: null,
  reason: "",
};

describe("benchmarkVerdictMetrics", () => {
  const metrics = [
    { ...METRIC, name: "open_rate", verdict: "above", available: true },
    { ...METRIC, name: "click_rate", verdict: "", available: true },
    { ...METRIC, name: "bounce_rate", verdict: "below", available: false },
    ...["a", "b", "c", "d", "e"].map((name) => ({
      ...METRIC,
      name,
      verdict: "on_par",
      available: true,
    })),
  ];

  it("keeps only available metrics with a verdict, at most five", () => {
    expect(
      benchmarkVerdictMetrics(benchmark({ metrics })).map((m) => m.name),
    ).toEqual(["open_rate", "a", "b", "c", "d"]);
  });

  it("returns nothing when the baseline is too thin or unavailable", () => {
    expect(
      benchmarkVerdictMetrics(benchmark({ metrics, baseline_sample_size: 4 })),
    ).toEqual([]);
    expect(
      benchmarkVerdictMetrics(
        benchmark({ metrics, baseline_available: false }),
      ),
    ).toEqual([]);
  });
});

describe("fan-in across the recent campaigns", () => {
  it("is all-or-nothing: one unfinished campaign read means no total", () => {
    expect(aggregateDevices([[], null])).toBeNull();
    expect(aggregateGeography([null])).toBeNull();
    expect(aggregateLinks([[], null])).toBeNull();
    expect(aggregateBounces([null])).toBeNull();
  });

  it("sums devices by client, blank client as Unknown, most opens first", () => {
    expect(
      aggregateDevices([
        [
          { client: "Gmail", opens: 5, clicks: 1 },
          { client: "", opens: 2, clicks: 0 },
        ],
        [
          { client: "Gmail", opens: 3, clicks: 2 },
          { client: "Outlook", opens: 9, clicks: 4 },
        ],
      ]),
    ).toEqual([
      { client: "Outlook", opens: 9, clicks: 4 },
      { client: "Gmail", opens: 8, clicks: 3 },
      { client: "Unknown", opens: 2, clicks: 0 },
    ]);
  });

  it("sums geography by country", () => {
    expect(
      aggregateGeography([
        [{ country: "DE", opens: 2, clicks: 1 }],
        [
          { country: "DE", opens: 3, clicks: 0 },
          { country: "US", opens: 4, clicks: 2 },
        ],
      ]),
    ).toEqual([
      { country: "DE", opens: 5, clicks: 1 },
      { country: "US", opens: 4, clicks: 2 },
    ]);
  });

  it("sums links by URL (summed campaign-uniques, best CTR), drops URL-less rows, top eight", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      url: `https://x.test/${i}`,
      clicks: i,
      unique_clickers: 1,
      ctr: 0.1,
    }));
    const links = aggregateLinks([
      [
        { url: "https://x.test/9", clicks: 100, unique_clickers: 7, ctr: 0.2 },
        { url: "", clicks: 999, unique_clickers: 999, ctr: 1 },
      ],
      many,
    ]);
    expect(links).toHaveLength(8);
    expect(links?.[0]).toEqual({
      url: "https://x.test/9",
      clicks: 109,
      unique_clickers: 8,
      ctr: 0.2,
    });
    expect(links?.map((l) => l.url)).not.toContain("");
    expect(links?.[7]?.url).toBe("https://x.test/2");
  });

  it("sums bounce counts", () => {
    expect(
      aggregateBounces([
        { hard: 1, soft: 2, spam_trap: 0, total: 3 },
        { hard: 4, soft: 0, spam_trap: 1, total: 6 },
      ]),
    ).toEqual({ hard: 5, soft: 2, spam_trap: 1, total: 9 });
    expect(aggregateBounces([])).toEqual({
      hard: 0,
      soft: 0,
      spam_trap: 0,
      total: 0,
    });
  });
});

describe("donut slices", () => {
  it("top five mail clients, the rest folded into Other", () => {
    const devices = [
      ["A", 10],
      ["B", 9],
      ["C", 8],
      ["D", 7],
      ["E", 6],
      ["F", 2],
      ["", 1],
    ].map(([client, opens]) => ({
      client: client as string,
      opens: opens as number,
      clicks: 0,
    }));
    expect(buildMailClientSlices(devices)).toEqual([
      { label: "A", value: 10 },
      { label: "B", value: 9 },
      { label: "C", value: 8 },
      { label: "D", value: 7 },
      { label: "E", value: 6 },
      { label: "Other", value: 3 },
    ]);
    expect(buildMailClientSlices(devices.slice(0, 2))).toHaveLength(2);
  });

  it("bounce slices are hard / soft / spam trap", () => {
    expect(
      buildBounceSlices({ hard: 1, soft: 2, spam_trap: 3, total: 6 }),
    ).toEqual([
      { label: "Hard", value: 1 },
      { label: "Soft", value: 2 },
      { label: "Spam trap", value: 3 },
    ]);
  });
});

describe("openableLinkUrl", () => {
  it("opens only http(s) destinations", () => {
    expect(openableLinkUrl("https://example.com/a?b=1")).toBe(
      "https://example.com/a?b=1",
    );
    expect(openableLinkUrl("http://example.com")).toBe("http://example.com/");
    expect(openableLinkUrl("javascript:alert(1)")).toBeNull();
    expect(openableLinkUrl("data:text/html,x")).toBeNull();
    expect(openableLinkUrl("/relative")).toBeNull();
    expect(openableLinkUrl("")).toBeNull();
  });
});
