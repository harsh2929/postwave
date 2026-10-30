// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure view-model for the Analytics page's campaign-derived panels — the web
// port of desktop's useAnalyticsDashboardViewModel (buildEngagementSeries /
// buildFunnelRows / buildCampaignChartEvidence / buildMailClientSlices) and
// the per-campaign fan-in the desktop controller does inline
// (useAnalyticsDashboardController.ts:370-534).
//
// No React, no transport: every function takes what the readers in
// lib/campaign-analytics-api.ts already parsed, so the arithmetic that decides
// what a panel claims is unit-tested on its own.
//
// Two rules hold throughout:
//
//  * A partial fan-in is not a total. Summing the devices of three campaigns
//    because the other two failed would print a mail-client mix for "your
//    recent campaigns" that is actually a different, smaller population. The
//    aggregators therefore take every campaign's rows or nothing; the caller
//    decides what to say when one read failed.
//  * Unique counts are per campaign. `unique_clickers` from the link report
//    is deduplicated within one campaign, so the summed figure is labelled
//    as a sum of campaign-uniques, never as distinct people.

import type {
  CampaignBenchmark,
  CampaignBenchmarkMetric,
  CampaignBounceCounts,
  CampaignDeviceRow,
  CampaignGeographyRow,
  CampaignLinkRow,
  CampaignReport,
} from "@/lib/campaign-analytics-api";
import { benchmarkCanVerdict } from "@/lib/campaign-analytics-api";

/** Desktop's "recent campaigns" window: listCampaigns({page:1, perPage:5}). */
export const RECENT_CAMPAIGN_COUNT = 5;

/** The one campaign identity the panels need. */
export interface RecentCampaign {
  id: string;
  name: string;
}

/** Campaign display name, falling back the way desktop does. */
export function recentCampaignName(campaign: {
  name?: string | null;
  subject?: string | null;
}): string {
  const name = campaign.name?.trim();
  if (name) return name;
  const subject = campaign.subject?.trim();
  return subject || "Untitled";
}

/* -------------------------------------------------------------------------
 * Engagement velocity (desktop buildEngagementSeries)
 * ---------------------------------------------------------------------- */

export interface EngagementPoint {
  date: string;
  count: number;
}

export interface EngagementSeries {
  opens: EngagementPoint[];
  clicks: EngagementPoint[];
  replies: EngagementPoint[];
}

/**
 * The `days` calendar dates ending today, oldest first, as YYYY-MM-DD in
 * UTC. Desktop set LOCAL midnight and then read the date back with
 * toISOString(), which names yesterday for every reader east of UTC; the
 * gateway buckets days in UTC (`CURRENT_DATE`), so the axis does too.
 */
export function rangeDates(days: number, now: Date = new Date()): string[] {
  const count = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const dates: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    dates.push(new Date(today - offset * 86_400_000).toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * A dashboard sparkline carries values but no dates; its LAST value is
 * today. Align the tail of the values to the tail of the axis — a series
 * longer than the window keeps its most recent values, a shorter one covers
 * only the most recent dates rather than being stretched across the range.
 */
export function alignSparklineToDates(
  values: readonly number[],
  dates: readonly string[],
): EngagementPoint[] {
  if (values.length === 0 || dates.length === 0) return [];
  const trimmed = values.slice(Math.max(0, values.length - dates.length));
  return dates.slice(dates.length - trimmed.length).map((date, index) => {
    const value = trimmed[index];
    return {
      date,
      count: typeof value === "number" && Number.isFinite(value) ? value : 0,
    };
  });
}

export function buildEngagementSeries(
  days: number,
  opens: readonly number[],
  clicks: readonly number[],
  replies: ReadonlyArray<{ date: string; replies: number }> | null,
  now: Date = new Date(),
): EngagementSeries {
  const dates = rangeDates(days, now);
  return {
    opens: alignSparklineToDates(opens, dates),
    clicks: alignSparklineToDates(clicks, dates),
    replies: (Array.isArray(replies) ? replies : []).map((point) => ({
      date: point.date,
      count: Number.isFinite(point.replies) ? point.replies : 0,
    })),
  };
}

/** Desktop draws the velocity chart once any series has two points. */
export function engagementSeriesHasData(series: EngagementSeries): boolean {
  return (
    series.opens.length > 1 ||
    series.clicks.length > 1 ||
    series.replies.length > 1
  );
}

/**
 * One row per date across every series, oldest first, `null` where a series
 * has no value for that date (not 0 — "not measured" and "none happened"
 * are different cells in the accessible table).
 */
export function engagementTableRows(series: EngagementSeries): Array<{
  date: string;
  opens: number | null;
  clicks: number | null;
  replies: number | null;
}> {
  const byDate = new Map<
    string,
    { opens: number | null; clicks: number | null; replies: number | null }
  >();
  const cell = (date: string) => {
    let row = byDate.get(date);
    if (!row) {
      row = { opens: null, clicks: null, replies: null };
      byDate.set(date, row);
    }
    return row;
  };
  for (const point of series.opens) cell(point.date).opens = point.count;
  for (const point of series.clicks) cell(point.date).clicks = point.count;
  for (const point of series.replies) cell(point.date).replies = point.count;
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, row]) => ({ date, ...row }));
}

/**
 * SVG path for one series drawn against a SHARED date axis and y-domain, so
 * three series with different spans line up by date instead of each being
 * stretched to the full width. Dates not on the axis are dropped.
 */
export function linePathOnAxis(
  points: readonly EngagementPoint[],
  axis: readonly string[],
  box: { width: number; height: number; pad: number; max: number },
): string {
  if (axis.length < 2) return "";
  const index = new Map(axis.map((date, position) => [date, position]));
  const stepX = box.width / (axis.length - 1);
  const usable = box.height - box.pad * 2;
  const max = box.max > 0 ? box.max : 1;
  const coords = points.flatMap((point) => {
    const position = index.get(point.date);
    if (position === undefined) return [];
    const value = Math.max(0, point.count);
    return [
      {
        x: position * stepX,
        y: box.pad + (1 - Math.min(value, max) / max) * usable,
      },
    ];
  });
  if (coords.length < 2) return "";
  return coords
    .map(
      (c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`,
    )
    .join(" ");
}

/* -------------------------------------------------------------------------
 * Engagement funnel (desktop buildFunnelRows)
 * ---------------------------------------------------------------------- */

export interface FunnelRow {
  label: "Sent" | "Delivered" | "Opened" | "Clicked";
  value: number;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Sent → Delivered → Opened → Clicked. Each step is capped by the one before
 * it: an open total can exceed deliveries (one person opens twice), and a
 * funnel that widens is not a funnel. `emailsSent === null` means the
 * gateway sent no per-email send count, which is not the same as zero sends.
 */
export function buildFunnelRows(
  emailsSent: number | null,
  bounces: number,
  opens: number,
  clicks: number,
): FunnelRow[] {
  const sent = emailsSent === null ? 0 : nonNegative(emailsSent);
  const delivered =
    emailsSent === null ? 0 : Math.max(0, sent - nonNegative(bounces));
  const opened = Math.min(nonNegative(opens), delivered);
  const clicked = Math.min(nonNegative(clicks), opened);
  return [
    { label: "Sent", value: sent },
    { label: "Delivered", value: delivered },
    { label: "Opened", value: opened },
    { label: "Clicked", value: clicked },
  ];
}

/** Desktop readFlatStats: only a positive send count is a send count. */
export function funnelEmailsSent(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * Conversion of each step against the PREVIOUS step (desktop Funnel
 * `showConversion`), as a fraction. The first step has nothing before it,
 * and a step after an empty step is null rather than a divide-by-zero.
 */
export function funnelStepConversions(rows: readonly FunnelRow[]): Array<
  number | null
> {
  return rows.map((row, index) => {
    if (index === 0) return null;
    const previous = rows[index - 1]?.value ?? 0;
    return previous > 0 ? row.value / previous : null;
  });
}

/* -------------------------------------------------------------------------
 * Campaign performance (desktop buildCampaignChartEvidence)
 * ---------------------------------------------------------------------- */

export interface CampaignEvidenceRow {
  id: string;
  name: string;
  opens: number;
  clicks: number;
}

export interface CampaignChartEvidence {
  rows: CampaignEvidenceRow[];
  /** Recent campaigns whose report is not (yet, or at all) available. */
  missingReports: number;
  /** False when every loaded report is all-zero — "No campaigns yet". */
  hasData: boolean;
}

export function buildCampaignChartEvidence(
  campaigns: readonly RecentCampaign[],
  reports: Readonly<Record<string, CampaignReport | undefined>>,
): CampaignChartEvidence {
  const rows: CampaignEvidenceRow[] = [];
  let hasData = false;
  for (const campaign of campaigns) {
    const report = reports[campaign.id];
    if (!report) continue;
    rows.push({
      id: campaign.id,
      name: campaign.name,
      opens: nonNegative(report.unique_opens),
      clicks: nonNegative(report.unique_clicks),
    });
    if (
      report.sent > 0 ||
      report.unique_opens > 0 ||
      report.unique_clicks > 0
    ) {
      hasData = true;
    }
  }
  return {
    rows,
    missingReports: Math.max(0, campaigns.length - rows.length),
    hasData,
  };
}

/**
 * The benchmark metrics that may be shown WITH a verdict, capped at five
 * like desktop. Empty when the baseline is too thin to judge against — a
 * verdict from three comparison campaigns is a coin flip wearing a label.
 */
export function benchmarkVerdictMetrics(
  benchmark: CampaignBenchmark,
): CampaignBenchmarkMetric[] {
  if (!benchmarkCanVerdict(benchmark)) return [];
  return benchmark.metrics
    .filter((metric) => metric.available && metric.verdict !== "")
    .slice(0, 5);
}

/* -------------------------------------------------------------------------
 * Fan-in across the recent campaigns — all-or-nothing
 * ---------------------------------------------------------------------- */

/**
 * Sum mail-client rows across campaigns, keyed by client ("Unknown" when the
 * gateway could not infer one), most opens first. `null` in the input means
 * that campaign's read has not succeeded, so there is no total to report.
 */
export function aggregateDevices(
  perCampaign: ReadonlyArray<readonly CampaignDeviceRow[] | null>,
): CampaignDeviceRow[] | null {
  if (perCampaign.some((rows) => rows === null)) return null;
  const totals = new Map<string, CampaignDeviceRow>();
  for (const rows of perCampaign) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = row.client || "Unknown";
      const total = totals.get(key) ?? { client: key, opens: 0, clicks: 0 };
      total.opens += nonNegative(row.opens);
      total.clicks += nonNegative(row.clicks);
      totals.set(key, total);
    }
  }
  return [...totals.values()].sort(
    (left, right) =>
      right.opens - left.opens || left.client.localeCompare(right.client),
  );
}

export function aggregateGeography(
  perCampaign: ReadonlyArray<readonly CampaignGeographyRow[] | null>,
): CampaignGeographyRow[] | null {
  if (perCampaign.some((rows) => rows === null)) return null;
  const totals = new Map<string, CampaignGeographyRow>();
  for (const rows of perCampaign) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = row.country || "Unknown";
      const total = totals.get(key) ?? { country: key, opens: 0, clicks: 0 };
      total.opens += nonNegative(row.opens);
      total.clicks += nonNegative(row.clicks);
      totals.set(key, total);
    }
  }
  return [...totals.values()].sort(
    (left, right) =>
      right.opens - left.opens || left.country.localeCompare(right.country),
  );
}

export const TOP_LINK_LIMIT = 8;

/**
 * Sum link rows by URL, most clicks first, top eight (desktop). Rows with no
 * URL identify no destination and are dropped. `unique_clickers` is SUMMED
 * campaign-uniques — one person clicking the same URL in two campaigns
 * counts twice — and `ctr` keeps the best single-campaign CTR, since CTRs
 * over different denominators do not add.
 */
export function aggregateLinks(
  perCampaign: ReadonlyArray<readonly CampaignLinkRow[] | null>,
): CampaignLinkRow[] | null {
  if (perCampaign.some((rows) => rows === null)) return null;
  const totals = new Map<string, CampaignLinkRow>();
  for (const rows of perCampaign) {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row.url) continue;
      const total = totals.get(row.url) ?? {
        url: row.url,
        clicks: 0,
        unique_clickers: 0,
        ctr: 0,
      };
      total.clicks += nonNegative(row.clicks);
      total.unique_clickers += nonNegative(row.unique_clickers);
      if (nonNegative(row.ctr) > total.ctr) total.ctr = nonNegative(row.ctr);
      totals.set(row.url, total);
    }
  }
  return [...totals.values()]
    .sort(
      (left, right) =>
        right.clicks - left.clicks || left.url.localeCompare(right.url),
    )
    .slice(0, TOP_LINK_LIMIT);
}

export function aggregateBounces(
  perCampaign: ReadonlyArray<CampaignBounceCounts | null>,
): CampaignBounceCounts | null {
  if (perCampaign.some((counts) => counts === null)) return null;
  return perCampaign.reduce<CampaignBounceCounts>(
    (sum, counts) => ({
      hard: sum.hard + nonNegative(counts?.hard ?? 0),
      soft: sum.soft + nonNegative(counts?.soft ?? 0),
      spam_trap: sum.spam_trap + nonNegative(counts?.spam_trap ?? 0),
      total: sum.total + nonNegative(counts?.total ?? 0),
    }),
    { hard: 0, soft: 0, spam_trap: 0, total: 0 },
  );
}

/* -------------------------------------------------------------------------
 * Donut slices
 * ---------------------------------------------------------------------- */

export interface DonutSlice {
  label: string;
  value: number;
}

/** Top five mail clients by opens, the rest folded into "Other" (desktop). */
export function buildMailClientSlices(
  devices: readonly CampaignDeviceRow[],
): DonutSlice[] {
  const sorted = devices
    .slice()
    .sort(
      (left, right) =>
        right.opens - left.opens ||
        (left.client || "Unknown").localeCompare(right.client || "Unknown"),
    );
  const slices = sorted.slice(0, 5).map((device) => ({
    label: device.client || "Unknown",
    value: nonNegative(device.opens),
  }));
  const other = sorted
    .slice(5)
    .reduce((sum, device) => sum + nonNegative(device.opens), 0);
  if (other > 0) slices.push({ label: "Other", value: other });
  return slices;
}

export function buildBounceSlices(bounces: CampaignBounceCounts): DonutSlice[] {
  return [
    { label: "Hard", value: nonNegative(bounces.hard) },
    { label: "Soft", value: nonNegative(bounces.soft) },
    { label: "Spam trap", value: nonNegative(bounces.spam_trap) },
  ];
}

/**
 * A tracked destination may only become a link when it is http(s). The URL
 * is recorded from campaign content, and a `javascript:` destination opened
 * from the Analytics page would run in the app's origin.
 */
export function openableLinkUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}
