import { describe, expect, it } from "vitest";

import type {
  Campaign,
  CampaignBenchmarkResponse,
  CampaignReport,
  CohortRow,
  DeviceRow,
  ReplyTimeseriesResponse,
} from "../../lib/api-client";
import { validateCampaignBenchmarkResponse } from "../../lib/api-client";
import {
  unwrapCampaignList,
  unwrapCohorts,
} from "../../pages/analytics/useAnalyticsDashboardController";
import {
  buildCampaignChartEvidence,
  buildCohortHeatmapModel,
  buildEngagementSeries,
  buildFunnelRows,
  buildMailClientSlices,
} from "../../pages/analytics/useAnalyticsDashboardViewModel";

describe("analytics dashboard controller boundaries", () => {
  it("normalizes every supported campaign-list response shape", () => {
    const campaigns = [{ id: "campaign-1" }] as Campaign[];
    expect(unwrapCampaignList(campaigns)).toBe(campaigns);
    expect(unwrapCampaignList({ items: campaigns })).toBe(campaigns);
    expect(unwrapCampaignList({ results: campaigns })).toBe(campaigns);
    expect(unwrapCampaignList({ data: campaigns })).toBe(campaigns);
    expect(unwrapCampaignList(null)).toEqual([]);
  });

  it("accepts the benchmark producer envelope and rejects an array/object mismatch", () => {
    const envelope: CampaignBenchmarkResponse = {
      campaign_id: "campaign-1",
      baseline_days: 90,
      baseline_from: "2026-04-01T00:00:00Z",
      baseline_to: "2026-06-30T00:00:00Z",
      as_of: "2026-06-30T00:00:00Z",
      timezone: "UTC",
      baseline_selection: "sent_campaigns_by_last_recipient_sent_at",
      baseline_sample_size: 6,
      minimum_sample_size: 5,
      baseline_available: true,
      this: {
        recipients: 100,
        open_rate: 0.4,
        click_rate: 0.1,
        bounce_rate: 0.02,
        complaint_rate: 0,
        unsubscribe_rate: 0,
      },
      tenant_baseline: {
        recipients: 1000,
        open_rate: 0.3,
        click_rate: 0.08,
        bounce_rate: 0.03,
        complaint_rate: 0.001,
        unsubscribe_rate: 0.002,
      },
      metrics: [
        {
          name: "open_rate",
          value: 0.4,
          baseline: 0.3,
          delta: 0.1,
          delta_pct: 33.3,
          percentile: 80,
          verdict: "above",
          available: true,
        },
      ],
    };
    expect(
      validateCampaignBenchmarkResponse("campaign-1", { data: envelope }),
    ).toEqual({ data: envelope });
    const malformed = validateCampaignBenchmarkResponse("campaign-1", {
      data: envelope.metrics,
    } as unknown as { data: CampaignBenchmarkResponse });
    expect(malformed.error?.code).toBe("invalid_campaign_benchmark_response");
  });

  it("normalizes bare and enveloped cohort responses without leaking invalid data", () => {
    const cohorts = [
      { cohort_label: "2026-01", cohort_size: 4, weeks: [0.5] },
    ] as CohortRow[];
    expect(unwrapCohorts(cohorts)).toBe(cohorts);
    expect(unwrapCohorts({ items: cohorts })).toBe(cohorts);
    expect(unwrapCohorts({ items: "invalid" })).toEqual([]);
    expect(unwrapCohorts(undefined)).toEqual([]);
  });
});

describe("analytics dashboard derived view model", () => {
  it("aligns oversized sparklines to the selected window and coerces reply counts", () => {
    const replies = {
      points: [
        { date: "2026-01-03", replies: 3 },
        { date: "2026-01-04", replies: "invalid" },
      ],
    } as unknown as ReplyTimeseriesResponse;
    const series = buildEngagementSeries(
      "7d",
      [1, 2, 3, 4, 5, 6, 7, 8],
      [11, 12],
      replies,
      new Date(2026, 0, 8, 12),
    );
    expect(series.opens.map((point) => point.count)).toEqual([
      2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(series.clicks.map((point) => point.count)).toEqual([11, 12]);
    expect(series.replies).toEqual([
      { date: "2026-01-03", count: 3 },
      { date: "2026-01-04", count: 0 },
    ]);
  });

  it("keeps the engagement funnel monotone when repeat events exceed delivery", () => {
    expect(buildFunnelRows(100, 5, 140, 120)).toEqual([
      { label: "Sent", value: 100 },
      { label: "Delivered", value: 95 },
      { label: "Opened", value: 95 },
      { label: "Clicked", value: 95 },
    ]);
    expect(buildFunnelRows(null, 5, 8, 3)).toEqual([
      { label: "Sent", value: 0 },
      { label: "Delivered", value: 0 },
      { label: "Opened", value: 0 },
      { label: "Clicked", value: 0 },
    ]);
  });

  it("preserves immature cohort weeks as absent cells instead of zeroes", () => {
    expect(
      buildCohortHeatmapModel([
        {
          cohort_label: "2026-05",
          cohort_size: 20,
          weeks: [0.5, 0.25],
        },
        {
          cohort_label: "2026-06",
          cohort_size: 10,
          weeks: [0.4],
        },
        {
          cohort_label: "2026-07",
          cohort_size: 4,
          weeks: [],
        },
      ]),
    ).toEqual({
      columns: ["W1", "W2"],
      immatureCells: 3,
      observedCells: 3,
      rows: [
        {
          label: "2026-05",
          size: 20,
          values: [0.5, 0.25],
        },
        {
          label: "2026-06",
          size: 10,
          values: [0.4],
        },
        {
          label: "2026-07",
          size: 4,
          values: [],
        },
      ],
    });
  });

  it("uses only verified campaign reports and preserves valid zero unique counts", () => {
    const campaigns = [
      { id: "one", name: "One" },
      { id: "missing", name: "Missing" },
    ] as Campaign[];
    const report = {
      campaign_id: "one",
      sent: 100,
      delivered: 90,
      opens: 40,
      unique_opens: 0,
      clicks: 20,
      unique_clicks: 0,
    } as CampaignReport;
    expect(buildCampaignChartEvidence(campaigns, { one: report })).toEqual({
      categories: ["One"],
      opens: [0],
      clicks: [0],
      missingReports: 1,
      hasData: true,
    });
  });

  it("sorts mail clients deterministically and rolls the remainder into Other", () => {
    const devices = [
      { client: "Zulu", opens: 2, clicks: 0 },
      { client: "Beta", opens: 10, clicks: 0 },
      { client: "Alpha", opens: 10, clicks: 0 },
      { client: "Delta", opens: 8, clicks: 0 },
      { client: "Echo", opens: 7, clicks: 0 },
      { client: "Foxtrot", opens: 6, clicks: 0 },
      { client: "Golf", opens: 5, clicks: 0 },
    ] as DeviceRow[];
    expect(buildMailClientSlices(devices)).toEqual([
      { label: "Alpha", value: 10 },
      { label: "Beta", value: 10 },
      { label: "Delta", value: 8 },
      { label: "Echo", value: 7 },
      { label: "Foxtrot", value: 6 },
      { label: "Other", value: 7 },
    ]);
  });
});
