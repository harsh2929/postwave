/**
 * hooks/useAnalytics.ts — the three server-backed reads behind the mobile
 * Analytics screen.
 *
 * Each one is a route that exists today in
 * apps/api/internal/analytics/handlers.go::MountRoutes, all behind the
 * `read:reports` scope:
 *
 *   GET /api/v1/analytics/subscribers/timeseries?range=7d|30d|90d
 *       → { range, points: [{ date, count }] }  (end-of-day cumulative totals)
 *   GET /api/v1/analytics/template-leaderboard?days=1..365
 *       → { items: [{ template_id, template_name, sent, opens, clicks, … }] }
 *   GET /api/v1/analytics/fatigue?days=1..365
 *       → { deciles: [{ sends_bucket, subscribers, open_rate, unsub_rate }] }
 *
 * Two more live beside them, mounted elsewhere but read by the same screen:
 *
 *   GET /api/v1/conversions/attribution/campaigns?days=1..365
 *       → attribution.go::AdminAttributionCampaigns, also `read:reports`
 *   GET /api/v1/dashboard/benchmarks
 *       → dashboard_layout.go::GetBenchmarks, `read:reports` + heavy-read
 *
 * Nothing is derived here: parsing and interpretation live in
 * lib/analyticsSeries so they are testable without React Native. This file is
 * only cache identity, gating and transport.
 *
 * Staleness: analytics windows are server-computed over days, so a 5-minute
 * staleTime is generous rather than stingy — re-running a decile scan every
 * time the user scrolls back to the tab would cost the API far more than it
 * would tell the user.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseReachReport,
  REACH_UNAVAILABLE_MESSAGE,
  type HumanEngagedReach,
} from "@/lib/humanEngagedReach";
import type { DashboardRange } from "@/hooks/useDashboard";
import {
  parseFatigueDeciles,
  parseSubscriberTimeseries,
  parseTemplateLeaderboard,
  type FatigueDecile,
  type LeaderboardRow,
  type SubscriberPoint,
} from "@/lib/analyticsSeries";
import { parseBenchmarks, type Benchmarks } from "@/lib/benchmarks";
import { parseClvSummary, type ClvSummary } from "@/lib/clvSummary";
import { parseCohorts, type CohortRow } from "@/lib/cohortRetention";
import {
  parseDataSufficiency,
  parseRfmSegments,
  type DataSufficiency,
  type RfmSegment,
} from "@/lib/predictiveReadiness";
import {
  groupedTimeseriesPath,
  parseGroupedTimeseries,
  type GroupedDimension,
  type GroupedMetric,
  type GroupedSeries,
} from "@/lib/groupedTimeseries";
import {
  parseRevenueAttribution,
  type RevenueAttribution,
} from "@/lib/revenueAttribution";
import {
  parseSubscriberFunnel,
  type SubscriberFunnel,
} from "@/lib/subscriberFunnel";

const ANALYTICS_STALE_MS = 5 * 60_000;

/** Days behind each reporting window, matching the server's `range` enum. */
export function daysForRange(range: DashboardRange): number {
  return range === "7d" ? 7 : range === "90d" ? 90 : 30;
}

/**
 * Human label for a window. Spelled out rather than "7d" because it is read
 * aloud in accessibility labels and printed under charts, where a bare token
 * leaves the reader guessing whether today is included.
 */
export function rangeLabelFor(range: DashboardRange): string {
  return `Last ${daysForRange(range)} days`;
}

export function subscriberTimeseriesPath(range: DashboardRange): string {
  return `/api/v1/analytics/subscribers/timeseries?range=${range}`;
}

export function templateLeaderboardPath(days: number): string {
  return `/api/v1/analytics/template-leaderboard?days=${days}`;
}

export function fatiguePath(days: number): string {
  return `/api/v1/analytics/fatigue?days=${days}`;
}

export function attributionCampaignsPath(days: number): string {
  return `/api/v1/conversions/attribution/campaigns?days=${days}`;
}

/**
 * No window parameter: the handler reads `dashboard_benchmark_cache` at a fixed
 * 30-day window and ignores anything else, so sending a `range` here would
 * imply a control the server does not have.
 */
export const BENCHMARKS_PATH = "/api/v1/dashboard/benchmarks";

export function useSubscriberTimeseries(range: DashboardRange) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["analytics-subscriber-timeseries", gate.tenantId, range],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: ANALYTICS_STALE_MS,
    queryFn: async (): Promise<SubscriberPoint[]> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        subscriberTimeseriesPath(range),
      );
      return parseSubscriberTimeseries(res);
    },
  });
}

export function useTemplateLeaderboard(range: DashboardRange) {
  const gate = useOnlineQueryGate();
  const days = daysForRange(range);
  return useQuery({
    queryKey: ["analytics-template-leaderboard", gate.tenantId, days],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: ANALYTICS_STALE_MS,
    queryFn: async (): Promise<LeaderboardRow[]> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        templateLeaderboardPath(days),
      );
      return parseTemplateLeaderboard(res);
    },
  });
}

export function useSendFatigue(range: DashboardRange) {
  const gate = useOnlineQueryGate();
  const days = daysForRange(range);
  return useQuery({
    queryKey: ["analytics-fatigue", gate.tenantId, days],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: ANALYTICS_STALE_MS,
    queryFn: async (): Promise<FatigueDecile[]> => {
      const { client } = getClient();
      const res = await client.request<unknown>("GET", fatiguePath(days));
      return parseFatigueDeciles(res);
    },
  });
}

/**
 * Revenue attribution for the window.
 *
 * The response is an ENVELOPE, not a list — `items` alone would drop the
 * unattributed half, the provenance split and the currency disclosure, which
 * are the three things that stop this card overstating what email earned. So
 * the parsed envelope is the query's data, and the section derives from it.
 */
export function useRevenueAttribution(range: DashboardRange) {
  const gate = useOnlineQueryGate();
  const days = daysForRange(range);
  return useQuery({
    queryKey: ["conversions-attribution-campaigns", gate.tenantId, days],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: ANALYTICS_STALE_MS,
    queryFn: async (): Promise<RevenueAttribution> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        attributionCampaignsPath(days),
      );
      return parseRevenueAttribution(res);
    },
  });
}

/**
 * Platform benchmarks. Cached far longer than the rest of this file: the server
 * aggregates them once a day, so a 5-minute staleTime would re-fetch a figure
 * that cannot have moved every time the reader returns to the tab.
 */
const BENCHMARKS_STALE_MS = 6 * 60 * 60_000;

/**
 * Signup-month cohorts and their week-by-week engagement,
 * `GET /api/v1/analytics/cohorts` (handlers.go:67, `read:reports`).
 *
 * NOT keyed on the screen's reporting window, and that is not an oversight:
 * a cohort's clock starts at ITS OWN signup date, so the series has no
 * relationship to "the last 7 days". Passing the screen's range here would
 * produce a number that looks like it answers the selected window and does
 * not. `weeks` bounds how far past signup to follow each cohort; the server
 * caps it at 26 and truncates every cohort to the weeks it has actually
 * lived through.
 */
export const COHORT_WEEKS = 12;

export function cohortsPath(weeks: number): string {
  return `/api/v1/analytics/cohorts?bucket=month&metric=retention&weeks=${weeks}`;
}

export function useCohorts(weeks: number = COHORT_WEEKS) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["analytics-cohorts", gate.tenantId, weeks],
    enabled: gate.enabled && Boolean(gate.tenantId),
    // Cohorts move once a week at most; the 5-minute window the rest of this
    // file uses would re-run a 12-cohort scan for a figure that cannot have
    // changed.
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<CohortRow[]> => {
      const { client } = getClient();
      const res = await client.request<unknown>("GET", cohortsPath(weeks));
      return parseCohorts(res);
    },
  });
}

export function useBenchmarks() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["dashboard-benchmarks", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: BENCHMARKS_STALE_MS,
    queryFn: async (): Promise<Benchmarks> => {
      const { client } = getClient();
      const res = await client.request<unknown>("GET", BENCHMARKS_PATH);
      return parseBenchmarks(res);
    },
  });
}

/**
 * Signup → first purchase → repeat purchase,
 * `GET /api/v1/analytics/subscribers/funnel` (handlers.go:472, `read:reports`).
 *
 * NOT keyed on the screen's reporting window, for the same reason cohorts are
 * not: the server buckets by SIGNUP MONTH and its `weeks` parameter is read as
 * months (service.go:1026). "Last 7 days" has no meaning against a funnel whose
 * shortest bucket is a calendar month, and sending one would imply a control
 * the endpoint does not have.
 *
 * `bucket` and `cohort_by` are sent explicitly even though the server defaults
 * to both: they are the ONLY values it accepts (anything else is a 400
 * `validation_failed`), so naming them keeps the contract visible at the call
 * site rather than in a handler two repositories away.
 */
export const FUNNEL_MONTHS = 12;

export function subscriberFunnelPath(months: number): string {
  return `/api/v1/analytics/subscribers/funnel?bucket=month&cohort_by=created_at_month&weeks=${months}`;
}

export function useSubscriberFunnel(months: number = FUNNEL_MONTHS) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["analytics-subscriber-funnel", gate.tenantId, months],
    enabled: gate.enabled && Boolean(gate.tenantId),
    // Month cohorts move once a month; the 5-minute window would re-run a
    // twelve-cohort commerce join for a figure that cannot have changed.
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<SubscriberFunnel> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        subscriberFunnelPath(months),
      );
      return parseSubscriberFunnel(res);
    },
  });
}

/**
 * Per-group daily series, `GET /api/v1/analytics/timeseries` (handlers.go:106,
 * `read:reports`). Keyed on the dimension AND the metric because they are two
 * independent controls on the card: switching either must not read the other's
 * cached answer.
 */
export function useGroupedTimeseries(
  dimension: GroupedDimension,
  metric: GroupedMetric,
  range: DashboardRange,
) {
  const gate = useOnlineQueryGate();
  const days = daysForRange(range);
  return useQuery({
    queryKey: [
      "analytics-grouped-timeseries",
      gate.tenantId,
      dimension,
      metric,
      days,
    ],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: ANALYTICS_STALE_MS,
    queryFn: async (): Promise<GroupedSeries[]> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        groupedTimeseriesPath(dimension, metric, days),
      );
      return parseGroupedTimeseries(res);
    },
  });
}

/**
 * Predicted customer value, `GET /api/v1/clv-dashboard`
 * (predictive/predictive.go:127). Behind `read:reports` AND `read:subscribers`
 * — both read-only, so every signed-in role may read it; an API-key session
 * missing either scope gets a 403 the card renders as an error.
 *
 * The parser deliberately drops the payload's named customer previews; see
 * lib/clvSummary.ts. Cached for an hour: the snapshot only moves when the
 * predictive recompute job runs.
 */
export const CLV_DASHBOARD_PATH = "/api/v1/clv-dashboard";

export function useClvSummary() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["clv-dashboard-summary", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<ClvSummary> => {
      const { client } = getClient();
      const res = await client.request<unknown>("GET", CLV_DASHBOARD_PATH);
      return parseClvSummary(res);
    },
  });
}

/**
 * Model COVERAGE, `GET /api/v1/predictive/data-sufficiency`
 * (predictive/predictive.go:126), and the RFM shape of the customer base,
 * `GET /api/v1/predictive/rfm/segments` (:125). DASHBOARD#31.
 *
 * A WIDER GATE THAN THE VALUE CARD ABOVE, deliberately: both of these sit
 * behind `read:reports` ALONE, where `/clv-dashboard` also requires
 * `read:subscribers` because its payload carries email addresses. Neither of
 * these is recipient-linked — three bucket counts and a group-by — so a
 * report-scoped session that gets a 403 from the value card still reads these
 * two, and each renders its own state rather than being hidden behind the
 * other's failure.
 *
 * Both move only when the predictive recompute job runs, so they share the
 * value card's one-hour staleTime rather than being refetched per visit.
 */
export function useDataSufficiency() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["predictive-data-sufficiency", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<DataSufficiency | null> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        "/api/v1/predictive/data-sufficiency",
      );
      return parseDataSufficiency(res);
    },
  });
}

export function useRfmSegments() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["predictive-rfm-segments", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<readonly RfmSegment[]> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        "/api/v1/predictive/rfm/segments",
      );
      return parseRfmSegments(res);
    },
  });
}

/**
 * The human-engaged reach floor (F12). Window-independent like the other
 * platform reads: the server picks its own window and reports it, so a phone
 * control that appeared to change it would be lying.
 */
export function useHumanEngagedReach() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["human-engaged-reach", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: BENCHMARKS_STALE_MS,
    queryFn: async (): Promise<HumanEngagedReach> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        "/api/v1/analytics/human-engaged-reach",
      );
      // Strict parse: a partial report rendered as zeros would read as
      // "nobody engaged" rather than "this did not load".
      const report = parseReachReport(res);
      if (!report) throw new Error(REACH_UNAVAILABLE_MESSAGE);
      return report;
    },
  });
}
