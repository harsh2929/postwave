/**
 * hooks/useAnalyticsScreen.ts — everything the Analytics screen READS, in one
 * place.
 *
 * The screen was doing what the dashboard screen used to do: ten queries, two
 * persisted preferences, a manual-refresh fan-out, a freshness clock and a
 * failure taxonomy all inline, which is how a screen quietly becomes
 * untestable and how it silently blows the source budget. Nothing here renders
 * and nothing here decides layout.
 *
 * The three decisions worth keeping visible:
 *
 *  - THREE QUERIES DELIBERATELY IGNORE THE WINDOW. Benchmarks are a fixed
 *    30-day platform aggregate; cohorts and the signup→purchase funnel are
 *    bucketed by each cohort's own signup month; the customer-value snapshot
 *    moves only when the predictive recompute job runs. Keying any of them on
 *    the screen's range would imply a control the endpoint does not have.
 *  - THE SCREEN IS ONLY AS FRESH AS ITS STALEST SECTION. Nothing here polls,
 *    so `oldestUpdatedAt` reports the weakest link rather than letting a
 *    six-hour-old benchmark hide behind a revenue read from a second ago.
 *  - THE BREAKDOWN CARD'S TWO CONTROLS ARE PREFERENCES, not component state.
 *    A reader watching one mailbox provider should not re-choose it every
 *    visit, and the values are validated against the endpoint's whitelist on
 *    read so a stored value from a future build cannot produce a 400.
 */
import { useCallback, useState } from "react";

import { useAnalyticsAsk } from "@/hooks/useAnalyticsAsk";
import {
  rangeLabelFor,
  useBenchmarks,
  useHumanEngagedReach,
  useClvSummary,
  useCohorts,
  useDataSufficiency,
  useGroupedTimeseries,
  useRevenueAttribution,
  useRfmSegments,
  useSendFatigue,
  useSubscriberFunnel,
  useSubscriberTimeseries,
  useTemplateLeaderboard,
} from "@/hooks/useAnalytics";
import {
  DEFAULT_DASHBOARD_RANGE,
  isDashboardRange,
  useDashboardStatsQuery,
  type DashboardRange,
} from "@/hooks/useDashboard";
import { useListPreferences } from "@/hooks/useListPreferences";
import { useNowTicker } from "@/hooks/useNowTicker";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { freshnessSentence, oldestUpdatedAt } from "@/lib/auditGrouping";
import { isProbablyOnline } from "@/lib/connectivity";
import { classifyDashboardFailure, hidesMetrics } from "@/lib/dashboardFailure";
import {
  isGroupedDimension,
  isGroupedMetric,
  type GroupedDimension,
  type GroupedMetric,
} from "@/lib/groupedTimeseries";
import { buildAnalyticsExportPlan } from "@/lib/analyticsExportSeries";
import { haptics } from "@/lib/haptics";

/**
 * The array behind a query, or an empty one.
 *
 * `query.data ?? []` is a NULLISH guard: it passes a truthy `{}` or the
 * `{items: []}` envelope straight into the `.map` below, and every consumer
 * here iterates. The queryFns all normalise to arrays, so a LIVE response is
 * safe — a RESTORED persisted cache written by an older response shape is not,
 * which is exactly how `app/(tabs)/api-keys.tsx` shipped "Invalid attempt to
 * spread non-iterable instance" in this repo.
 */
function rowsOf<T>(value: readonly T[] | undefined): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function useAnalyticsScreen() {
  const gate = useOnlineQueryGate();

  const [prefs, setPrefs] = useListPreferences("analytics", {
    range: DEFAULT_DASHBOARD_RANGE as string,
    groupDimension: "campaign" as string,
    groupMetric: "opens" as string,
  });
  const range: DashboardRange = isDashboardRange(prefs.range)
    ? prefs.range
    : DEFAULT_DASHBOARD_RANGE;
  const groupDimension: GroupedDimension = isGroupedDimension(
    prefs.groupDimension,
  )
    ? prefs.groupDimension
    : "campaign";
  const groupMetric: GroupedMetric = isGroupedMetric(prefs.groupMetric)
    ? prefs.groupMetric
    : "opens";

  // Shares the dashboard's cache entry for this window; `focused: false` keeps
  // this screen from adding a second 30s poll on top of the dashboard's.
  const stats = useDashboardStatsQuery({ range, focused: false });
  const growth = useSubscriberTimeseries(range);
  const leaderboard = useTemplateLeaderboard(range);
  const fatigue = useSendFatigue(range);
  const revenue = useRevenueAttribution(range);
  const grouped = useGroupedTimeseries(groupDimension, groupMetric, range);
  // The four window-independent reads — see the header.
  const benchmarks = useBenchmarks();
  const reach = useHumanEngagedReach();
  const cohorts = useCohorts();
  const funnel = useSubscriberFunnel();
  const clv = useClvSummary();
  // DASHBOARD#31. Model COVERAGE and the RFM band mix. Separate queries from
  // `clv` on purpose: they sit behind `read:reports` alone where the value
  // card also needs `read:subscribers`, so a report-scoped session that gets a
  // 403 from the value card still reads these.
  const sufficiency = useDataSufficiency();
  const rfm = useRfmSegments();

  // Every section is served from a stale-tolerant cache and nothing here
  // polls, so without a manual refresh a reader who has just sent a campaign
  // has no way to ask for the current numbers.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    haptics.tap();
    setRefreshing(true);
    void Promise.allSettled([
      stats.refetch(),
      growth.refetch(),
      leaderboard.refetch(),
      fatigue.refetch(),
      revenue.refetch(),
      grouped.refetch(),
      // Benchmarks are re-aggregated once a day; a manual pull is still the
      // only way to pick up a fresh one without waiting out the 6h staleTime.
      benchmarks.refetch(),
      // Pull-to-refresh must move the reach card too. A card left stale by an
      // explicit refresh is worse than one that never updates: the reader has
      // just been told the screen is current.
      reach.refetch(),
      cohorts.refetch(),
      funnel.refetch(),
      clv.refetch(),
      sufficiency.refetch(),
      rfm.refetch(),
    ])
      .then(() => haptics.success())
      .finally(() => setRefreshing(false));
  }, [
    benchmarks,
    reach,
    clv,
    cohorts,
    fatigue,
    funnel,
    grouped,
    growth,
    leaderboard,
    revenue,
    rfm,
    stats,
    sufficiency,
  ]);

  const now = useNowTicker();
  const freshness = freshnessSentence(
    "Figures",
    oldestUpdatedAt([
      stats.dataUpdatedAt,
      growth.dataUpdatedAt,
      leaderboard.dataUpdatedAt,
      fatigue.dataUpdatedAt,
      revenue.dataUpdatedAt,
      grouped.dataUpdatedAt,
      benchmarks.dataUpdatedAt,
      cohorts.dataUpdatedAt,
      funnel.dataUpdatedAt,
      clv.dataUpdatedAt,
      sufficiency.dataUpdatedAt,
      rfm.dataUpdatedAt,
    ]),
    now,
  );

  const failure = stats.isError
    ? classifyDashboardFailure(stats.error, { online: isProbablyOnline() })
    : null;

  // DASHBOARD#40. Assembled from what is ALREADY loaded, so the export is the
  // numbers on screen rather than a second, differently-windowed fetch. A
  // section that errored is passed as `failed` so the file NAMES it instead of
  // silently omitting rows a reader would take for zeroes.
  const exportPlan = buildAnalyticsExportPlan({
    growth: { rows: rowsOf(growth.data), failed: growth.isError },
    leaderboard: { rows: rowsOf(leaderboard.data), failed: leaderboard.isError },
    revenue: {
      rows: rowsOf(revenue.data?.items),
      currency: revenue.data?.currency ?? null,
      failed: revenue.isError,
    },
    bands: { rows: rowsOf(rfm.data), failed: rfm.isError },
  });

  return {
    gate,
    range,
    rangeLabel: rangeLabelFor(range),
    setRange: (next: DashboardRange) => setPrefs({ range: next }),
    groupDimension,
    groupMetric,
    setGroupDimension: (next: GroupedDimension) =>
      setPrefs({ groupDimension: next }),
    setGroupMetric: (next: GroupedMetric) => setPrefs({ groupMetric: next }),
    stats,
    growth,
    leaderboard,
    fatigue,
    revenue,
    grouped,
    benchmarks,
    reach,
    cohorts,
    funnel,
    clv,
    sufficiency,
    rfm,
    ask: useAnalyticsAsk(),
    refreshing,
    onRefresh,
    freshness,
    failure,
    exportPlan,
    /** A restricted or lapsed session must not paint a screen of em-dashes. */
    restricted: hidesMetrics(failure),
  };
}
