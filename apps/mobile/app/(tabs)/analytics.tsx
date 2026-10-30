/**
 * Analytics — the mobile reporting surface.
 *
 * Before this screen the phone could not answer a single question the four
 * dashboard tiles did not already answer: there was no `/api/v1/analytics/*`
 * call anywhere in the app. The desktop ships six analytics tabs across ten
 * pages; most of that is desk work. What belongs on a phone is the handful of
 * questions you ask while walking away from your laptop:
 *
 *   "Are we growing?"          → subscriber timeseries
 *   "Is delivery healthy?"     → open / click / bounce vs the previous window
 *   "What's working?"          → template leaderboard
 *   "Are we mailing too much?" → the send-fatigue decile curve
 *   "Are new signups worse?"   → the cohort-retention headline
 *   …and anything else         → Ask, at the top of the screen
 *
 * ASK IS THE ONE THAT MATTERS MOST HERE. A desktop can render twenty charts
 * and let the reader hunt for the one that answers their question. A phone
 * cannot — but it can render ONE answer, which is what
 * `POST /api/v1/analytics/nlq` returns. It sits above every chart for that
 * reason, not below them.
 *
 * Shape: vertical SECTIONS, not tabs. Sections scroll past in one gesture and
 * each carries its own loading/empty/error state, so one failing endpoint
 * cannot blank the others — with tabs, a reader has to remember which tab held
 * which number and pay a navigation cost to compare two of them.
 *
 * TWO SECTIONS DELIBERATELY IGNORE THE WINDOW CONTROL, and say so in their own
 * copy: benchmarks are a fixed 30-day platform aggregate (the handler ignores
 * a window), and cohorts are measured from each cohort's own signup date. A
 * control that appears to apply and does not is worse than no control.
 *
 * Every other section shares one reporting window, chosen once at the top and
 * persisted per identity. The deliverability section reads the dashboard-stats
 * payload the app already caches, so it costs no extra request. Nothing here
 * polls, so the header carries the age of the STALEST section — the numbers on
 * a screen nobody refreshes are only as good as their timestamp.
 */
import { RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ErrorState } from "@/components/ErrorState";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { SegmentedControl } from "@/components/SegmentedControl";
import { CardBoundary } from "@/components/dashboard/CardBoundary";
import { useNowTicker } from "@/hooks/useNowTicker";
import {
  AnalyticsFootnote,
  AnalyticsHeader,
} from "@/components/analytics/AnalyticsChrome";
import { AskAnalyticsSection } from "@/components/analytics/AskAnalyticsSection";
import { AudienceMixSection } from "@/components/analytics/AudienceMixSection";
import { BenchmarkSection } from "@/components/analytics/BenchmarkSection";
import { BotOpenSplitSection } from "@/components/analytics/BotOpenSplitSection";
import { ReachSection } from "@/components/analytics/ReachSection";
import { RepliesSection } from "@/components/analytics/RepliesSection";
import { CustomerValueSection } from "@/components/analytics/CustomerValueSection";
import { LifecycleSection } from "@/components/analytics/LifecycleSection";
import { PredictiveReadinessSection } from "@/components/analytics/PredictiveReadinessSection";
import { DeliverabilitySection } from "@/components/analytics/DeliverabilitySection";
import { FatigueSection } from "@/components/analytics/FatigueSection";
import { FunnelSection } from "@/components/analytics/FunnelSection";
import { GroupedTrendSection } from "@/components/analytics/GroupedTrendSection";
import { GrowthSection } from "@/components/analytics/GrowthSection";
import { RetentionSection } from "@/components/analytics/RetentionSection";
import { SavedAnalyticsViews } from "@/components/analytics/SavedAnalyticsViews";
import { AnalyticsReportSections } from "@/components/analytics/AnalyticsReportSections";
import { RevenueSection } from "@/components/analytics/RevenueSection";
import { TopPerformersSection } from "@/components/analytics/TopPerformersSection";
import { FUNNEL_MONTHS, rangeLabelFor } from "@/hooks/useAnalytics";
import { useAnalyticsScreen } from "@/hooks/useAnalyticsScreen";
import {
  DASHBOARD_RANGES,
  pickBounceRate,
  pickClickRate,
  pickOpenRate,
} from "@/hooks/useDashboard";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  analyticsBoundaryColors,
  EMPTY_CLV_SUMMARY,
  EMPTY_FUNNEL,
  rowsOf,
} from "@/lib/analyticsScreenChrome";
import { useTheme } from "@/lib/theme";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

const RANGE_OPTIONS = DASHBOARD_RANGES.map((range) => ({
  value: range,
  label: rangeLabelFor(range).replace("Last ", ""),
}));

export default function Analytics() {
  useScreenViewed("analytics");
  const { t } = useTheme();
  // Every query, preference, refresh fan-out and derived fact lives in
  // `useAnalyticsScreen`; this file decides layout and nothing else.
  const {
    gate,
    range,
    rangeLabel,
    setRange,
    groupDimension,
    groupMetric,
    setGroupDimension,
    setGroupMetric,
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
    ask,
    refreshing,
    onRefresh,
    freshness,
    failure,
    exportPlan,
    restricted,
  } = useAnalyticsScreen();

  // A ticking clock, not a frozen one: the scheduled-reports section renders
  // "next run in 4 hours", and this screen stays mounted for a long time.
  const now = useNowTicker();

  const boundaryColors = analyticsBoundaryColors(t);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <AnalyticsHeader
        rangeLabel={rangeLabel}
        freshness={freshness}
        exportPlan={exportPlan}
        restricted={restricted}
      />
      <ScrollView
        contentContainerStyle={{
          padding: 16,
          paddingTop: 4,
          paddingBottom: 40,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        <SegmentedControl
          accessibilityLabel="Reporting window"
          options={RANGE_OPTIONS}
          value={range}
          onChange={setRange}
        />

        {/* Named presets over the two controls this screen owns — the window
            above and the breakdown below. Client-side and identity-scoped,
            like desktop's own saved views: there is no saved-views route in
            the manifest to call. */}
        <SavedAnalyticsViews
          current={{
            range,
            dimension: groupDimension,
            metric: groupMetric,
          }}
          onApply={(view) => {
            setRange(view.range);
            setGroupDimension(view.dimension);
            setGroupMetric(view.metric);
          }}
        />

        {restricted && failure ? (
          <View style={{ marginTop: 16 }}>
            {failure.retryLabel ? (
              // An expired session is recoverable; a permission boundary is
              // not. Titling both "Reports are restricted" sends a signed-out
              // user to an admin instead of to the sign-in screen.
              <ErrorState
                message={failure.message}
                onRetry={() => void stats.refetch()}
              />
            ) : (
              <MobileScopeNotice title={failure.title} body={failure.message} />
            )}
          </View>
        ) : (
          <>
            {/* FIRST, above every chart. A phone cannot render twenty charts
                and let the reader find the one that answers their question,
                but it can render one answer — so the question box is the
                screen's opening move, not a utility buried under the fold.
                It sits inside the `restricted` branch's else: a session that
                cannot read reports cannot ask about them either (the endpoint
                is behind the same `read:reports` scope). */}
            <CardBoundary label="Ask" colors={boundaryColors}>
              <AskAnalyticsSection ask={ask} online={gate.enabled} />
            </CardBoundary>

            <DeliverabilitySection
              stats={stats.data}
              loading={stats.isLoading}
              rangeLabel={rangeLabel}
            />
            {failure ? (
              <View style={{ marginTop: 8 }}>
                <ErrorState
                  message={failure.message}
                  {...(failure.retryLabel
                    ? { onRetry: () => void stats.refetch() }
                    : {})}
                  compact
                />
              </View>
            ) : null}

            {/* Directly under the three rates it interprets. Self-gating: with
                nothing measured, or no benchmark to measure against, it
                renders nothing rather than industry averages beside
                em-dashes. */}
            <CardBoundary label="Benchmark comparison" colors={boundaryColors}>
              <BenchmarkSection
                benchmarks={benchmarks.data}
                loading={benchmarks.isLoading}
                rates={{
                  opens: pickOpenRate(stats.data),
                  clicks: pickClickRate(stats.data),
                  bounces: pickBounceRate(stats.data),
                }}
              />
            </CardBoundary>

            <CardBoundary label="Human-engaged reach" colors={boundaryColors}>
              <ReachSection
                reach={reach.data}
                loading={reach.isLoading}
                error={reach.error}
              />
            </CardBoundary>

            {/* Beside the reach floor: how many of those opens were machines. */}
            <CardBoundary label="Machine vs human opens" colors={boundaryColors}>
              <BotOpenSplitSection />
            </CardBoundary>

            {/* The other honest engagement signal: reach says how many
                recipients were people; this says how many wrote back. */}
            <CardBoundary label="Replies" colors={boundaryColors}>
              <RepliesSection range={range} rangeLabel={rangeLabel} gate={gate} />
            </CardBoundary>

            {/* Directly under the rates and their benchmark: this is the card
                that says WHICH campaigns or mailbox providers produced them,
                which is the first question a rate that has moved provokes. */}
            <CardBoundary label="Breakdown" colors={boundaryColors}>
              <GroupedTrendSection
                query={grouped}
                series={rowsOf(grouped.data)}
                gate={gate}
                dimension={groupDimension}
                metric={groupMetric}
                onDimensionChange={setGroupDimension}
                onMetricChange={setGroupMetric}
                rangeLabel={rangeLabel}
              />
            </CardBoundary>

            <CardBoundary label="Revenue" colors={boundaryColors}>
              <RevenueSection
                query={revenue}
                report={revenue.data}
                gate={gate}
                rangeLabel={rangeLabel}
              />
            </CardBoundary>

            {/* Revenue says what email earned in the window; these two say what
                a customer is worth over their life and where the drop-off is.
                Both self-gate to a sentence rather than drawing a funnel of
                zeros for a workspace with no commerce orders. */}
            <CardBoundary label="Signup to purchase" colors={boundaryColors}>
              <FunnelSection
                query={funnel}
                funnel={funnel.data ?? EMPTY_FUNNEL}
                gate={gate}
                months={FUNNEL_MONTHS}
              />
            </CardBoundary>

            <CardBoundary label="Customer value" colors={boundaryColors}>
              <CustomerValueSection
                query={clv}
                summary={clv.data ?? EMPTY_CLV_SUMMARY}
                gate={gate}
              />
            </CardBoundary>

            {/* DASHBOARD#31. Directly under the value card, because it is the
                provenance for the numbers in it: a median computed over 4% of
                a list looks identical to one computed over 96%. Its own
                boundary and its own queries, so a 403 on the value card (which
                needs `read:subscribers` where this needs only `read:reports`)
                cannot take the coverage line down with it. */}
            <CardBoundary label="Model coverage" colors={boundaryColors}>
              <PredictiveReadinessSection
                query={sufficiency}
                sufficiency={sufficiency.data ?? null}
                segments={rowsOf(rfm.data)}
                gate={gate}
              />
            </CardBoundary>

            {/* Stage vocabulary vs occupancy (desktop's
                LifecycleDistributionCard). Self-contained — owns its query —
                and renders nothing on deployments without lifecycle routes,
                so the boundary only ever isolates a real render crash. */}
            <CardBoundary label="Lifecycle stages" colors={boundaryColors}>
              <LifecycleSection />
            </CardBoundary>

            {/* One chart per boundary: a hostile series in one section cannot
                blank the other three. */}
            <CardBoundary label="Audience growth" colors={boundaryColors}>
              <GrowthSection
                query={growth}
                points={rowsOf(growth.data)}
                gate={gate}
                rangeLabel={rangeLabel}
              />
            </CardBoundary>

            <CardBoundary label="Top performers" colors={boundaryColors}>
              <TopPerformersSection
                query={leaderboard}
                rows={rowsOf(leaderboard.data)}
                gate={gate}
                rangeLabel={rangeLabel}
              />
            </CardBoundary>

            {/* After the leaderboard: who the engaged were, across those sends. */}
            <CardBoundary label="Audience mix" colors={boundaryColors}>
              <AudienceMixSection />
            </CardBoundary>

            {/* Directly after growth: growth says how many joined, this says
                whether the ones who joined recently are behaving like the
                ones before them. Self-gating — renders a short explanation
                instead of a comparison when the cohorts cannot support one. */}
            <CardBoundary label="Cohort retention" colors={boundaryColors}>
              <RetentionSection
                query={cohorts}
                cohorts={rowsOf(cohorts.data)}
                gate={gate}
              />
            </CardBoundary>

            <CardBoundary label="Send fatigue" colors={boundaryColors}>
              <FatigueSection
                query={fatigue}
                deciles={rowsOf(fatigue.data)}
                gate={gate}
              />
            </CardBoundary>
          </>
        )}

        <AnalyticsReportSections now={now} boundaryColors={boundaryColors} />

        <AnalyticsFootnote />
      </ScrollView>
    </SafeAreaView>
  );
}
