// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AnalyticsHeader,
  BenchmarkBadge,
  KpiCard,
  campaignKey,
  deliverabilityScore,
  deltaPct,
  fmtCompact,
  fmtRate,
  metricKeyToCard,
  parseAnalyticsHash,
  rangeDays,
  readFlatStats,
  readSparkline,
  xTickStrideFor,
} from "../../components/analytics/AnalyticsPresentation";
import type { Campaign, DashboardStatsResponse } from "../../lib/api-client";

describe("analytics presentation formatters", () => {
  it("normalizes dashboard values without inventing an email denominator", () => {
    expect(readFlatStats(null).emails_sent).toBeNull();
    expect(
      readFlatStats({
        subscribers_total: 120,
        subscribers_added_30d: 8,
        opens_total_30d: 42,
        emails_sent_30d: 0,
      } as unknown as DashboardStatsResponse),
    ).toMatchObject({
      subscribers_total: 120,
      subscribers_added: 8,
      opens_total: 42,
      emails_sent: null,
      clicks_total: 0,
    });
  });

  it("reads only valid sparkline arrays", () => {
    const stats = {
      sparklines: { opens: [1, 3, 5], invalid: "1,3,5" },
    } as unknown as DashboardStatsResponse;
    expect(readSparkline(stats, "opens")).toEqual([1, 3, 5]);
    expect(readSparkline(stats, "invalid")).toEqual([]);
    expect(readSparkline(null, "opens")).toEqual([]);
  });

  it("keeps range and rate formatting explicit", () => {
    expect([rangeDays("7d"), rangeDays("30d"), rangeDays("90d")]).toEqual([
      7, 30, 90,
    ]);
    expect([
      xTickStrideFor("7d"),
      xTickStrideFor("30d"),
      xTickStrideFor("90d"),
    ]).toEqual([1, 5, 15]);
    expect(fmtRate(8, 0)).toBe("—");
    expect(fmtRate(8, 20)).toBe("40.0%");
    expect(fmtCompact(1_250)).toBe("1.3k");
  });

  it("computes bounded health scores and reviewed deltas", () => {
    expect(
      deliverabilityScore({ bounceRate: 1, complaintRate: 0, unsubRate: 1 }),
    ).toEqual({
      score: 97,
      band: "good",
    });
    expect(
      deliverabilityScore({
        bounceRate: 100,
        complaintRate: 10,
        unsubRate: 10,
      }),
    ).toEqual({ score: 0, band: "bad" });
    expect(deltaPct(15, 10)).toBe(50);
    expect(deltaPct(15, 0)).toBeNull();
  });

  it("keeps campaign and dashboard drill-down identities stable", () => {
    expect(campaignKey({ id: 42 } as unknown as Campaign)).toBe("42");
    expect(campaignKey({ id: null } as unknown as Campaign)).toBe("");
    expect(metricKeyToCard("open_rate")).toBe("opens");
    expect(metricKeyToCard("subscribers")).toBe("subscribers");
    expect(metricKeyToCard("unknown")).toBeNull();

    window.location.hash = "#analytics?metric=opens&range=7d&focus=velocity";
    expect(parseAnalyticsHash()).toEqual({
      range: "7d",
      metric: "opens",
      focus: "velocity",
    });
  });
});

describe("analytics presentation components", () => {
  it("renders KPI identity, anomaly, trend, and benchmark state", () => {
    const card = renderToStaticMarkup(
      <KpiCard
        label="Open rate"
        value="42.0%"
        deltaPct={5}
        vsPrevious
        anomaly
        metricKey="opens"
        highlighted
      />,
    );
    expect(card).toContain('data-kpi-metric="opens"');
    expect(card).toContain("is-drilldown-highlight");
    expect(card).toContain("anomaly");
    expect(card).toContain("▲ 5.0% vs prev");
    const benchmarkBadge = renderToStaticMarkup(
      <BenchmarkBadge verdict="below" />,
    );
    expect(benchmarkBadge).toContain("below baseline");
    expect(benchmarkBadge).toContain('class="analytics-benchmark-badge"');
    expect(benchmarkBadge).toContain('class="analytics-benchmark-badge-dot"');
    expect(benchmarkBadge).toContain('data-verdict="below"');
  });

  it("renders honest live and range controls in the extracted header", () => {
    const html = renderToStaticMarkup(
      <AnalyticsHeader
        range="30d"
        onRange={() => undefined}
        customRange={null}
        onCustomRange={() => undefined}
        vsPrevious
        onVsPrevious={() => undefined}
        liveStatus="closed"
        liveUnavailable
        lastUpdated={null}
        onRefresh={() => undefined}
      />,
    );
    expect(html).toContain("Analytics");
    expect(html).toContain("KPI live updates unavailable");
    expect(html).toContain("Compare with prior period");
    expect(html).toContain("Snapshot panels · UTC");
    expect(html).toContain("Refresh");
    expect(html).toContain('aria-pressed="true">30d');
  });
});
