import { useMemo } from "react";

import type {
  Campaign,
  CampaignReport,
  CohortRow,
  DeviceRow,
  ReplyTimeseriesResponse,
} from "../../lib/api-client";
import type { DonutSlice } from "../../components/charts/Donut";
import type { FunnelRow } from "../../components/charts/Funnel";
import type { HeatmapRow } from "../../components/charts/Heatmap";
import {
  type Range,
  campaignKey,
  deliverabilityScore,
  pctNum,
  rangeDays,
  readFlatStats,
  readSparkline,
} from "../../components/analytics/AnalyticsPresentation";
import type { AnalyticsDashboardController } from "./useAnalyticsDashboardController";

interface EngagementPoint {
  date: string;
  count: number;
}

function unavailableNumber(): number | null {
  return null;
}

function unavailableDeliverability(): ReturnType<
  typeof deliverabilityScore
> | null {
  return null;
}

export interface EngagementSeries {
  clicks: EngagementPoint[];
  opens: EngagementPoint[];
  replies: EngagementPoint[];
}

export interface CampaignChartEvidence {
  categories: string[];
  opens: number[];
  clicks: number[];
  missingReports: number;
  hasData: boolean;
}

export interface CohortHeatmapModel {
  columns: string[];
  immatureCells: number;
  observedCells: number;
  rows: HeatmapRow[];
}

export function buildCohortHeatmapModel(
  cohorts: CohortRow[],
): CohortHeatmapModel {
  const safeCohorts = Array.isArray(cohorts) ? cohorts : [];
  const maxWeeks = Math.min(
    26,
    safeCohorts.reduce(
      (maximum, cohort) =>
        Math.max(
          maximum,
          Array.isArray(cohort.weeks) ? cohort.weeks.length : 0,
        ),
      0,
    ),
  );
  const rows = safeCohorts.map((cohort) => ({
    label: cohort.cohort_label,
    size: cohort.cohort_size,
    values: (Array.isArray(cohort.weeks) ? cohort.weeks : [])
      .slice(0, maxWeeks)
      .map((value) => (Number.isFinite(value) ? value : null)),
  }));
  const observedCells = rows.reduce(
    (total, row) =>
      total +
      row.values.filter(
        (value) => typeof value === "number" && Number.isFinite(value),
      ).length,
    0,
  );
  const immatureCells = rows.reduce(
    (total, row) => total + Math.max(0, maxWeeks - row.values.length),
    0,
  );
  return {
    columns: Array.from({ length: maxWeeks }, (_, index) => `W${index + 1}`),
    immatureCells,
    observedCells,
    rows,
  };
}

export function buildCampaignChartEvidence(
  campaigns: Campaign[],
  reports: Record<string, CampaignReport>,
): CampaignChartEvidence {
  const evidence = campaigns.flatMap((campaign) => {
    const report = reports[campaignKey(campaign)];
    return report ? [{ campaign, report }] : [];
  });
  return {
    categories: evidence.map(
      ({ campaign }) => campaign.name ?? campaign.subject ?? "Untitled",
    ),
    opens: evidence.map(({ report }) => report.unique_opens ?? report.opens),
    clicks: evidence.map(({ report }) => report.unique_clicks ?? report.clicks),
    missingReports: Math.max(0, campaigns.length - evidence.length),
    hasData:
      evidence.length > 0 &&
      evidence.some(
        ({ report }) =>
          report.sent > 0 ||
          (report.unique_opens ?? report.opens) > 0 ||
          (report.unique_clicks ?? report.clicks) > 0,
      ),
  };
}

export function buildMailClientSlices(devices: DeviceRow[]): DonutSlice[] {
  const sorted = devices
    .slice()
    .sort(
      (left, right) =>
        right.opens - left.opens ||
        (left.client || "Unknown").localeCompare(right.client || "Unknown"),
    );
  const slices = sorted.slice(0, 5).map((device) => ({
    label: device.client || "Unknown",
    value: device.opens,
  }));
  const other = sorted.slice(5).reduce((sum, device) => sum + device.opens, 0);
  if (other > 0) slices.push({ label: "Other", value: other });
  return slices;
}

function alignSparklineToDates(
  values: number[],
  dates: string[],
): EngagementPoint[] {
  if (values.length === 0) return [];
  const trimmed = values.slice(Math.max(0, values.length - dates.length));
  return dates
    .slice(dates.length - trimmed.length)
    .map((date, index) => ({ date, count: trimmed[index] ?? 0 }));
}

export function buildEngagementSeries(
  range: Range,
  opens: number[],
  clicks: number[],
  replies: ReplyTimeseriesResponse | null,
  now = new Date(),
): EngagementSeries {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dates: string[] = [];
  for (let offset = rangeDays(range) - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    dates.push(date.toISOString().slice(0, 10));
  }
  return {
    opens: alignSparklineToDates(opens, dates),
    clicks: alignSparklineToDates(clicks, dates),
    replies:
      replies?.points?.map((point) => ({
        date: point.date,
        count: Number(point.replies) || 0,
      })) ?? [],
  };
}

export function buildFunnelRows(
  emailsSent: number | null,
  bounces: number,
  opens: number,
  clicks: number,
): FunnelRow[] {
  const delivered = emailsSent !== null ? Math.max(0, emailsSent - bounces) : 0;
  const opened = Math.min(opens, delivered);
  const clicked = Math.min(clicks, opened);
  return [
    { label: "Sent", value: emailsSent ?? 0 },
    { label: "Delivered", value: delivered },
    { label: "Opened", value: opened },
    { label: "Clicked", value: clicked },
  ];
}

export function useAnalyticsDashboardViewModel(
  controller: AnalyticsDashboardController,
) {
  const {
    bounces,
    campaignReports,
    campaigns,
    cohorts,
    devices,
    err,
    loading,
    range,
    repliesSummary,
    repliesTs,
    stats,
  } = controller;
  const flat = useMemo(() => readFlatStats(stats), [stats]);
  const prev = stats?.previous;
  const anomalies = stats?.anomalies ?? {};
  const subsSpark = useMemo(() => readSparkline(stats, "subscribers"), [stats]);
  const opensSpark = useMemo(() => readSparkline(stats, "opens"), [stats]);
  const clicksSpark = useMemo(() => readSparkline(stats, "clicks"), [stats]);
  const bouncesSpark = useMemo(() => readSparkline(stats, "bounces"), [stats]);
  const repliesSpark = useMemo(
    () => repliesTs?.points?.map((point) => Number(point.replies) || 0) ?? [],
    [repliesTs],
  );

  const emailsSent = flat.emails_sent;
  const previousEmailsSent =
    typeof prev?.emails_sent === "number" && prev.emails_sent > 0
      ? prev.emails_sent
      : null;
  const openRate =
    emailsSent !== null ? pctNum(flat.opens_total, emailsSent) : null;
  const clickRate =
    emailsSent !== null ? pctNum(flat.clicks_total, emailsSent) : null;
  const bounceRate =
    emailsSent !== null ? pctNum(flat.bounces_total, emailsSent) : null;
  const unsubRate =
    emailsSent !== null ? pctNum(flat.subscribers_unsubbed, emailsSent) : null;
  const prevOpenRate =
    previousEmailsSent !== null
      ? pctNum(prev?.opens_total ?? 0, previousEmailsSent)
      : null;
  const prevClickRate =
    previousEmailsSent !== null
      ? pctNum(prev?.clicks_total ?? 0, previousEmailsSent)
      : null;
  const prevBounceRate =
    previousEmailsSent !== null
      ? pctNum(prev?.bounces_total ?? 0, previousEmailsSent)
      : null;
  const prevUnsubRate =
    previousEmailsSent !== null
      ? pctNum(prev?.subscribers_unsubbed ?? 0, previousEmailsSent)
      : null;

  // Campaign complaints are only loaded for the five recent campaigns while
  // bounce/unsubscribe rates cover the whole workspace range. Combining those
  // scopes into one score would be false precision.
  const complaintRate = unavailableNumber();
  const deliverability = unavailableDeliverability();
  const funnelRows = buildFunnelRows(
    emailsSent,
    flat.bounces_total,
    flat.opens_total,
    flat.clicks_total,
  );
  const engagementSeries = useMemo(
    () => buildEngagementSeries(range, opensSpark, clicksSpark, repliesTs),
    [clicksSpark, opensSpark, range, repliesTs],
  );
  const campaignEvidence = buildCampaignChartEvidence(
    campaigns,
    campaignReports,
  );
  const cats = campaignEvidence.categories;
  const opensSeries = campaignEvidence.opens;
  const clicksSeries = campaignEvidence.clicks;
  const campaignsHaveData = campaignEvidence.hasData;
  const mailClientSlices = buildMailClientSlices(devices);
  const bounceSlices: DonutSlice[] = bounces
    ? [
        { label: "Hard", value: bounces.hard },
        { label: "Soft", value: bounces.soft },
        { label: "Spam trap", value: bounces.spam_trap },
      ]
    : [];
  const replyRate =
    repliesSummary && emailsSent !== null
      ? pctNum(repliesSummary.matched, emailsSent)
      : null;
  // Canonical monetary truth is rendered by RevenueAttributionSection. The
  // legacy five-campaign revenue fanout mixed currencies and is intentionally
  // unavailable here.
  const revenueDisplay = null;
  const cohortHeatmap = useMemo(
    () => buildCohortHeatmapModel(cohorts),
    [cohorts],
  );
  const showAnalyticsHero =
    !loading &&
    !err &&
    (stats == null ||
      (flat.subscribers_total === 0 && flat.campaigns_sent === 0));

  return {
    anomalies,
    bounceRate,
    bounceSlices,
    bouncesSpark,
    campaignsHaveData,
    campaignReportsMissing: campaignEvidence.missingReports,
    cats,
    clickRate,
    clicksSeries,
    clicksSpark,
    cohortColumns: cohortHeatmap.columns,
    cohortHeatmapImmatureCells: cohortHeatmap.immatureCells,
    cohortHeatmapObservedCells: cohortHeatmap.observedCells,
    cohortHeatmapRows: cohortHeatmap.rows,
    complaintRate,
    deliverability,
    emailsSent,
    engagementSeries,
    flat,
    funnelHasData: emailsSent !== null,
    funnelRows,
    mailClientSlices,
    openRate,
    opensSeries,
    opensSpark,
    prev,
    prevBounceRate,
    prevClickRate,
    prevOpenRate,
    prevUnsubRate,
    replyRate,
    repliesSpark,
    revenueDisplay,
    showAnalyticsHero,
    subsSpark,
    unsubRate,
  };
}

export type AnalyticsDashboardViewModel = ReturnType<
  typeof useAnalyticsDashboardViewModel
>;
