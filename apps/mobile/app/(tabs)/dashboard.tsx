/**
 * Dashboard screen — at-a-glance view of the workspace's health.
 *
 * Composition only, and now literally so: every query, preference and derived
 * fact lives in `src/hooks/useDashboardScreen`, the cards live in
 * `src/components/dashboard/*`, and the numbers are derived in
 * `src/hooks/useDashboard` + `src/lib/dashboard*`. This file decides layout
 * and nothing else, so each piece is testable on its own.
 *
 * The behaviours worth knowing about, because each replaces something that was
 * quietly wrong:
 *
 *  - A FAILED LOAD IS NEVER AN EMPTY WORKSPACE. `stats` throws on an
 *    unreadable payload and every failure routes through the taxonomy in
 *    lib/dashboardFailure: a 403 reads as an access boundary, offline reads as
 *    offline, and the raw transport string is never shown to the user.
 *  - STALE IS LABELLED WHERE IT IS READ. When a background poll fails over
 *    cached data, the notice sits directly ABOVE the tiles, not below five
 *    cards and a campaign list where nobody scrolls.
 *  - FRESHNESS TICKS. A 1s clock (paused when the app backgrounds or the tab
 *    loses focus) drives both the Live badge and the age beside it, so the two
 *    can never disagree.
 *  - THE SCREEN STOPS WORKING WHEN NOBODY IS LOOKING. Polling is suspended for
 *    an unfocused tab; Expo Router keeps visited tabs mounted, so this was 120
 *    needless requests an hour on cellular.
 *
 * ── WHY PRESENCE LIVES HERE ────────────────────────────────────────────────
 * `<PresenceBar />` is workspace-scoped, so it is mounted on the one screen
 * whose subject IS the workspace — and deliberately nowhere else, so the same
 * sentence is not repeated on seventy tabs.
 *
 * It sits in the "right now" band directly above the freshness receipt because
 * the two answer the same question from opposite sides: the receipt says the
 * numbers are current, presence says you are not the only person looking at
 * them.
 *
 * It goes BELOW the two urgent strips, never over them: presence is advisory
 * (the server counts connections; nothing is locked), so it must not outrank a
 * send in flight. It self-gates like its neighbours — rendering nothing, and
 * reserving no space, when the reader is alone, which is the common case. The
 * margin rides on the component's own root for exactly that reason.
 */
import { router, useIsFocused } from "expo-router";
import { useRef, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PresenceBar } from "@/components/PresenceBar";
import { ScreenHeader } from "@/components/ScreenHeader";
import { ScrollToTop } from "@/components/ScrollToTop";
import { useToast } from "@/components/Toast";
import { CachedSessionNotice } from "@/components/CachedSessionNotice";
import { ActiveSendStrip } from "@/components/dashboard/ActiveSendStrip";
import { ResumeCard } from "@/components/dashboard/ResumeCard";
import { AnomalyHistoryCard } from "@/components/dashboard/AnomalyHistoryCard";
import { MaintenanceBanner } from "@/components/dashboard/MaintenanceBanner";
import { DashboardFailureNotice } from "@/components/dashboard/DashboardFailureNotice";
import { CardBoundary } from "@/components/dashboard/CardBoundary";
import { DashboardHeaderActions } from "@/components/dashboard/DashboardHeaderActions";
import { DashboardReportingControls } from "@/components/dashboard/DashboardReportingControls";
import { AuditFeedCard } from "@/components/dashboard/AuditFeedCard";
import { BounceMixCard } from "@/components/dashboard/BounceMixCard";
import { DashboardSectionHeading } from "@/components/dashboard/DashboardSectionHeading";
import { DashboardStatGrid } from "@/components/dashboard/DashboardStatGrid";
import { ForecastStrip } from "@/components/dashboard/ForecastStrip";
import { GoalsCard } from "@/components/dashboard/GoalsCard";
import { InsightsCard } from "@/components/dashboard/InsightsCard";
import {
  MetricActionsSheet,
  type MetricSheetTarget,
} from "@/components/dashboard/MetricActionsSheet";
import { MetricPickerSheet } from "@/components/dashboard/MetricPickerSheet";
import { InboxHealthCard } from "@/components/dashboard/InboxHealthCard";
import { RecentCampaignsCard } from "@/components/dashboard/RecentCampaignsCard";
import { DashboardOnboarding } from "@/components/onboarding/DashboardOnboarding";
import { useTourTarget } from "@/components/tour/TourProvider";
import { rangeLabelFor } from "@/hooks/useAnalytics";
import { useDashboardRefresh } from "@/hooks/useDashboardRefresh";
import { useTickingNow } from "@/hooks/useTickingNow";
import { pickSparkline, pickSubscribersTotal } from "@/hooks/useDashboard";
import { useDashboardScreen } from "@/hooks/useDashboardScreen";
import { eventBusFreshness, useEventBusHealth } from "@/lib/eventBusStatus";
import { msg } from "@/lib/i18n";
import { track } from "@/lib/telemetry";
import { useMotion } from "@/lib/motion";
import { useTheme } from "@/lib/theme";
import { EVENTS } from "@postwave/telemetry";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function Dashboard() {
  const { t } = useTheme();
  // LOVE#7 — see the reporting-window handler below.
  const { animateLayout } = useMotion();
  const { toast } = useToast();
  const focused = useIsFocused();
  const {
    onlineGate,
    gateNotice: dashboardGateNotice,
    range,
    setRange,
    stats,
    campaigns,
    anomalies,
    goals,
    auditEvents: dashboardAuditEvents,
    auditLoading,
    auditFailed,
    failure,
    restricted,
    metricsBlocked,
    workspaceName,
    headerSubtitle,
    tileOrder,
    hiddenTiles,
    toggleTile,
    tilePrefsReady,
    tileOrderFromServer,
  } = useDashboardScreen({ focused });

  // Tapping the active tab returns this long screen to its range controls.
  const scrollRef = useRef<ScrollView>(null);

  const statsRef = useRef<View>(null);
  const recentRef = useRef<View>(null);
  useTourTarget("dashboard.stats", statsRef);
  useTourTarget("dashboard.recent", recentRef);

  // One screen-owned sheet serves every long-pressed metric tile.
  const [inspected, setInspected] = useState<MetricSheetTarget | null>(null);
  const [picking, setPicking] = useState(false);

  // Keep manual refresh separate from background-poll `isFetching` flashes.
  const { refreshing: manualRefresh, onRefresh } = useDashboardRefresh({
    gateNotice: dashboardGateNotice,
    range,
    toast,
  });

  const now = useTickingNow(focused);
  const lastUpdate = stats.dataUpdatedAt;
  // The event bus carries freshness; the 30s poll is its safety net.
  const busHealth = useEventBusHealth();
  const streamTone = eventBusFreshness(busHealth, now).tone;
  const boundaryColors = {
    surface: t.surface,
    border: t.borderSubtle,
    text: t.fgMuted,
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      {/* Mounts the tabPress subscription only when a navigator is above us:
          `useScrollToTop` throws outside one, which took the whole screen
          down in any isolated render. */}
      <ScrollToTop targetRef={scrollRef} />
      <ScreenHeader
        title={msg("dashboard.title")}
        subtitle={headerSubtitle}
        // Global search had no entry point in app chrome — it was reachable
        // only by scrolling the More list to "Tools" — while desktop renders a
        // persistent search button on every screen.
        onSearch
        // The dashboard has the richer freshness receipt beside the metrics.
        // A second shell connection pill here would duplicate status and put
        // title + search + share + two variable-width labels on one phone row.
        hideStatus
        right={
          <DashboardHeaderActions
            stats={stats.data}
            workspaceName={workspaceName}
            rangeLabel={rangeLabelFor(range)}
          />
        }
      />
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{
          padding: 16,
          paddingTop: 4,
          paddingBottom: 32,
        }}
        refreshControl={
          <RefreshControl
            refreshing={manualRefresh}
            onRefresh={onRefresh}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        {/* Pinned ABOVE the reporting-window control, because a send in
            flight is not scoped by the window and is the one thing on this
            screen that will not still be true in ten minutes. Self-gating:
            renders nothing when no campaign is sending. */}
        <ActiveSendStrip
          campaigns={Array.isArray(campaigns.data) ? campaigns.data : []}
        />

        {/* Cross-device continuity. Self-gating like the strip above: renders
            nothing unless another device left a cursor this app can open. */}
        <ResumeCard />

        {/* Who else is here — see WHY PRESENCE LIVES HERE in the header. */}
        <PresenceBar style={{ marginBottom: 10 }} />

        <DashboardReportingControls
          range={range}
          onRangeChange={(next) => {
            // Configure the next layout pass before changing the range;
            // useMotion makes this a no-op under Reduce Motion.
            animateLayout("enter");
            setRange(next);
            track(EVENTS.MOBILE_DASHBOARD_RANGE_CHANGED, { range: next });
          }}
          lastUpdatedAt={lastUpdate}
          now={now}
          errored={stats.isError}
          stream={streamTone}
        />

        {/* Above the numbers it recontextualises; self-gating. See the
            component header. */}
        <MaintenanceBanner />

        {/* Failure lands ABOVE the numbers it invalidates. Which of the four
            notices is right is decided in one place, not inline here. */}
        <DashboardFailureNotice
          failure={failure}
          hasCachedData={Boolean(stats.data)}
          onRetry={() => void stats.refetch()}
        />

        {/* A restricted viewer gets the boundary notice above INSTEAD of a
            grid of em-dashes, which would read as "your workspace is empty"
            rather than "you are not allowed to see this". */}
        <View ref={statsRef} collapsable={false}>
          {restricted ? null : (
            <DashboardStatGrid
              stats={stats.data}
              loading={stats.isLoading}
              blocked={metricsBlocked}
              range={range}
              order={tileOrder}
              hidden={hiddenTiles}
              onInspect={setInspected}
              onDrilldown={(metric) =>
                track(EVENTS.MOBILE_METRIC_DRILLDOWN, { metric, range })
              }
              // Withheld until the stored preference has been read: a first
              // toggle against an un-hydrated set would discard it.
              {...(tilePrefsReady
                ? { onConfigure: () => setPicking(true) }
                : {})}
            />
          )}
          {/* Self-gating: renders nothing without seven daily points of
              positive growth, so it is absent on a new workspace rather than
              guessing. Blocked/restricted views never reach it. */}
          {restricted || metricsBlocked ? null : (
            <ForecastStrip
              sparkline={pickSparkline(stats.data, "subscribers") ?? undefined}
              currentTotal={pickSubscribersTotal(stats.data)}
            />
          )}
        </View>

        {/* Self-gating: renders nothing unless a figure MOVED against the
            previous window. Derived from the compare block the stats query
            already carries, so it costs no request — and prose is the one
            analytics form a phone is better at than a desktop. */}
        {restricted || metricsBlocked ? null : (
          <CardBoundary
            label={msg("dashboard.section.whatChanged")}
            colors={boundaryColors}
          >
            <InsightsCard
              stats={stats.data}
              rangeLabel={rangeLabelFor(range)}
            />
          </CardBoundary>
        )}

        {/* Self-gating: renders nothing when the workspace has set no targets.
            Read-only on the phone — creating one needs the admin scope and a
            period contract, which is desk work. */}
        {restricted ? null : (
          <CardBoundary
            label={msg("dashboard.section.goals")}
            colors={boundaryColors}
          >
            <GoalsCard
              goals={Array.isArray(goals.data) ? goals.data : []}
              loading={goals.isLoading}
              now={now}
            />
          </CardBoundary>
        )}

        {/* Renders nothing when nothing has fired — an "all clear" card every
            day trains the reader to skip the region on the day it matters. */}
        {restricted ? null : (
          <CardBoundary
            label={msg("dashboard.section.anomalies")}
            colors={boundaryColors}
          >
            <AnomalyHistoryCard
              events={Array.isArray(anomalies.data) ? anomalies.data : []}
            />
          </CardBoundary>
        )}

        {dashboardGateNotice ? (
          <CachedSessionNotice
            notice={dashboardGateNotice}
            variant={stats.data || campaigns.data ? "stale" : "blocked"}
            style={{ marginTop: 14 }}
          />
        ) : null}

        {/* First-run onboarding: self-gates to render nothing once the
            workspace is set up or the user has dismissed it. */}
        <DashboardOnboarding />

        {/* Same reasoning as the grid: with no readable stats this card says
            "Inbox health data is not available yet", which reads as "your
            workspace has none" rather than "you can't see this". */}
        {restricted ? null : (
          <InboxHealthCard stats={stats.data} loading={stats.isLoading} />
        )}

        {/* The follow-up question to the score above: a bounce RATE says how
            much failed, never which failure — and hard / blocked / soft are
            three different jobs. Self-gating: nothing renders on a workspace
            with no bounces in the window. */}
        {restricted || metricsBlocked ? null : <BounceMixCard />}

        <DashboardSectionHeading
          heading={msg("dashboard.section.happening")}
          linkLabel={msg("dashboard.link.viewAll")}
          linkAccessibilityLabel={msg("dashboard.link.viewAll.a11y")}
          onPressLink={() => router.push("/(tabs)/audit")}
        />
        <CardBoundary
          label={msg("dashboard.section.recentActivity")}
          colors={boundaryColors}
        >
          <AuditFeedCard
            events={dashboardAuditEvents}
            loading={auditLoading}
            failed={auditFailed}
          />
        </CardBoundary>

        <DashboardSectionHeading
          heading={msg("dashboard.section.recentCampaigns")}
          linkLabel={msg("dashboard.link.seeAll")}
          linkAccessibilityLabel={msg("dashboard.link.seeAll.a11y")}
          onPressLink={() => router.push("/(tabs)/campaigns")}
        />

        <View ref={recentRef} collapsable={false}>
          <RecentCampaignsCard
            query={campaigns}
            campaigns={Array.isArray(campaigns.data) ? campaigns.data : []}
            gate={onlineGate}
            gateNotice={dashboardGateNotice}
          />
        </View>
      </ScrollView>
      <MetricActionsSheet
        target={inspected}
        onClose={() => setInspected(null)}
        workspaceName={workspaceName}
        rangeLabel={rangeLabelFor(range)}
      />
      <MetricPickerSheet
        visible={picking}
        order={tileOrder}
        hidden={hiddenTiles}
        onToggle={toggleTile}
        onClose={() => setPicking(false)}
        orderFromServer={tileOrderFromServer}
      />
    </SafeAreaView>
  );
}
