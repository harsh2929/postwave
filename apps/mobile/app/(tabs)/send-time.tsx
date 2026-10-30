/**
 * Send time — when your audience is actually reading, as a week you can see.
 *
 * WHAT WAS MISSING. Mobile already had the two ENDS of send-time optimisation:
 * the per-subscriber best hour on a contact's profile
 * (SubscriberBestSendTimeCard) and the schedule-by-best-time commit inside the
 * campaign schedule modal (useCampaignBestTime). What it had no form of at all
 * was the MIDDLE — the aggregate picture that makes either of those a decision
 * rather than a guess. This screen is that middle, and nothing more: it is a
 * read surface with no writes on it.
 *
 * WHERE THE DATA COMES FROM, AND WHY NOT THE OTHER ONE. `GET
 * /api/v1/send-time-opt/best-time-analysis` is tenant-wide, needs no parameter
 * and always answers 200 with all 168 cells. Its sibling
 * `/api/v1/send-time-opt/heatmap` requires a segment and 404s below thirty
 * subscribers with open history, so it opens onto a picker and then, for most
 * workspaces, onto a dead end — and it returns only a normalised fraction per
 * cell, where this one returns sent/delivered/opened/clicked and can therefore
 * say WHY a cell is bright. lib/sendTimeAnalysis carries the full comparison.
 * That reasoning still holds for the DEFAULT view and no longer excludes the
 * sibling: `/heatmap` is now offered as an OPTIONAL scope beneath the tenant
 * grid (SendTimeSegmentScopeCard), where the picker is a deliberate choice
 * rather than a toll gate and the 404 is rendered as the server's own sentence
 * instead of a dead end. A tenant average across a B2B list and a consumer list
 * describes neither, and that is the question the scoped read exists for.
 *
 * WHY IT IS ADMIN. The route is mounted behind
 * `RequireScope(ScopeReadReports, ScopeAdmin)`, and the presence of `ScopeAdmin`
 * in that list makes `requireAdminRoleForScopes` true, which makes
 * `sessionRoleAllowsScopes` demand owner/admin on the session path
 * (apikeys/middleware.go:332-458). Viewer, member and editor all receive
 * 403 `insufficient_role`. The shell's SecondaryRouteGuard denies the route
 * from its manifest row; the hook ALSO refuses to fire, so a session that
 * somehow reaches this path costs zero guaranteed-403 round trips.
 *
 * THE ONE RULE THIS SCREEN IS BUILT AROUND. A zero on this grid is ambiguous on
 * the wire — `finalizeBucket` leaves `open_rate` at 0.0 both for an hour that
 * flopped and for an hour nobody has ever used. Those are opposite facts.
 * `bucketMetric` returns null for the second, the heatmap paints it as an
 * outline rather than as the coldest colour, and every number derived from it
 * prints an em-dash.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { Card } from "@/components/Card";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { SendTimeDefaultCard } from "@/components/campaigns/SendTimeDefaultCard";
import { SendTimeCellDetail } from "@/components/sendtime/SendTimeCellDetail";
import { SendTimeHeatmap } from "@/components/sendtime/SendTimeHeatmap";
import { SendTimeSegmentScopeCard } from "@/components/sendtime/SendTimeSegmentScopeCard";
import { SendTimeWindowList } from "@/components/sendtime/SendTimeWindowList";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  useCanReadSendTimeAnalysis,
  useSendTimeAnalysis,
} from "@/hooks/useSendTimeAnalysis";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { goBackOrMore } from "@/lib/nav";
import {
  analysisIsEmpty,
  analysisTotals,
  bucketAt,
  DEFAULT_SEND_TIME_LOOKBACK,
  metricIsMeasurable,
  metricPeak,
  SEND_TIME_LOOKBACKS,
  SEND_TIME_METRICS,
  topWindows,
  type SendTimeBucket,
  type SendTimeLookback,
  type SendTimeMetric,
} from "@/lib/sendTimeAnalysis";
import {
  deviceOffsetMinutes,
  SEND_TIME_METRIC_EXPLANATION,
  SEND_TIME_METRIC_LABEL,
} from "@/lib/sendTimeLabels";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export { AppErrorBoundary as ErrorBoundary };

const TOP_WINDOW_COUNT = 5;

/** Which cell is open, addressed by coordinates so it survives a refetch. */
interface SendTimeCell {
  dayOfWeek: number;
  hourUTC: number;
}

function SectionHeading({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.semibold,
        textTransform: "uppercase",
        letterSpacing: 0.8,
      }}
    >
      {children}
    </Text>
  );
}

function Body({ children, tone }: { children: string; tone?: "muted" }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: tone === "muted" ? t.fgSubtle : t.fgMuted,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}

export default function SendTimeScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const allowed = useCanReadSendTimeAnalysis();
  useScreenViewed("send-time");

  const [days, setDays] = useState<SendTimeLookback>(DEFAULT_SEND_TIME_LOOKBACK);
  const [metric, setMetric] = useState<SendTimeMetric>("score");
  // The COORDINATES of the inspected cell, never the cell itself. A refetch
  // replaces the whole grid, and a held bucket object would go on printing the
  // previous window's counts underneath a heatmap that had already moved on —
  // two copies of one measurement, free to disagree.
  const [selectedAt, setSelectedAt] = useState<SendTimeCell | null>(null);

  const query = useSendTimeAnalysis(days);
  const refresh = useRefreshControl(query);
  const analysis = query.data ?? null;

  // The device's UTC offset is read once per render rather than per cell: it
  // cannot change mid-render, and threading it through as a parameter is what
  // keeps the projection itself pure and testable.
  const offsetMinutes = useMemo(() => deviceOffsetMinutes(), []);

  const peak = analysis ? metricPeak(analysis, metric) : 0;
  const measurable = analysis ? metricIsMeasurable(analysis, metric) : false;
  const windows = useMemo(
    () => (analysis ? topWindows(analysis, metric, TOP_WINDOW_COUNT) : []),
    [analysis, metric],
  );
  const totals = useMemo(
    () => (analysis ? analysisTotals(analysis) : null),
    [analysis],
  );
  const selected = useMemo(
    () =>
      analysis && selectedAt
        ? bucketAt(analysis, selectedAt.dayOfWeek, selectedAt.hourUTC)
        : null,
    [analysis, selectedAt],
  );

  const onSelect = useCallback((bucket: SendTimeBucket) => {
    setSelectedAt((current) =>
      current &&
      current.dayOfWeek === bucket.dayOfWeek &&
      current.hourUTC === bucket.hourUTC
        ? null
        : { dayOfWeek: bucket.dayOfWeek, hourUTC: bucket.hourUTC },
    );
  }, []);

  const changeLookback = useCallback((next: SendTimeLookback) => {
    setDays(next);
    // The selected cell belongs to the window it was read from; carrying it
    // across a window change would print last window's counts under this
    // window's heading.
    setSelectedAt(null);
  }, []);

  if (!allowed) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <ScreenHeader title="Send time" onBack={goBackOrMore} />
        <View style={{ padding: 16 }}>
          <Card style={{ gap: 8 }}>
            <Text
              {...typeCap("heading")}
              style={{
                color: t.fg,
                ...typeStyle("heading"),
                fontFamily: FONT.semibold,
              }}
            >
              Admin access required
            </Text>
            <Body>
              The send-time analysis reads workspace-wide reporting, which the
              API restricts to owners and admins. Ask an admin to share what you
              need, or open a specific contact — a subscriber&apos;s own best
              hour is on their profile.
            </Body>
          </Card>
        </View>
      </SafeAreaView>
    );
  }

  const empty = analysis !== null && analysisIsEmpty(analysis);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Send time"
        {...(totals
          ? {
              subtitle: `${num(totals.delivered)} delivered · last ${days} days`,
            }
          : {})}
        onBack={goBackOrMore}
      />

      <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 10 }}>
        <SegmentedControl
          accessibilityLabel="Lookback window"
          options={SEND_TIME_LOOKBACKS.map((value) => ({
            value: String(value) as `${SendTimeLookback}`,
            label: `${value}d`,
          }))}
          value={String(days) as `${SendTimeLookback}`}
          onChange={(next) => changeLookback(Number(next) as SendTimeLookback)}
        />
        <SegmentedControl
          accessibilityLabel="Heatmap metric"
          scrollable
          options={SEND_TIME_METRICS.map((value) => ({
            value,
            label: SEND_TIME_METRIC_LABEL[value],
          }))}
          value={metric}
          onChange={setMetric}
        />
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: 16,
          paddingTop: 12,
          paddingBottom: 40,
          gap: 16,
          flexGrow: 1,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        <QueryStates
          query={query}
          gate={gate}
          isEmpty={analysis === null || empty}
          offlineMessage="You're offline, so the send-time analysis can't be loaded. Reconnect and pull to refresh."
          skeleton={<SkeletonList rows={6} />}
          empty={{
            title: "Nothing measured yet",
            description: `No campaign was sent in the last ${days} days and no subscriber has a modelled best hour, so there is no week to draw. Send a campaign, or widen the window.`,
          }}
        >
          {analysis ? (
            <>
              <Card style={{ gap: 12 }}>
                <SectionHeading>
                  {`${SEND_TIME_METRIC_LABEL[metric]} by hour · UTC`}
                </SectionHeading>
                {measurable ? (
                  <SendTimeHeatmap
                    analysis={analysis}
                    metric={metric}
                    peak={peak}
                    selected={selected}
                    onSelect={onSelect}
                  />
                ) : (
                  <Body>
                    {metric === "signal"
                      ? "No subscriber has a modelled best hour yet. That model needs several engagement events per contact before it commits to one, so it stays empty on a young workspace."
                      : `Nothing was sent in the last ${days} days, so there is no ${SEND_TIME_METRIC_LABEL[metric].toLowerCase()} to plot. Switch to Audience to see where your subscribers are modelled to read.`}
                  </Body>
                )}
                <Body tone="muted">{SEND_TIME_METRIC_EXPLANATION[metric]}</Body>
              </Card>

              {selected ? (
                <SendTimeCellDetail
                  bucket={selected}
                  offsetMinutes={offsetMinutes}
                />
              ) : null}

              <View style={{ gap: 10 }}>
                <SectionHeading>
                  {`Strongest windows · ${SEND_TIME_METRIC_LABEL[metric]}`}
                </SectionHeading>
                {windows.length > 0 ? (
                  <SendTimeWindowList
                    windows={windows}
                    metric={metric}
                    offsetMinutes={offsetMinutes}
                    selected={selected}
                    onSelect={onSelect}
                  />
                ) : (
                  <Body>
                    Nothing in this window has a measurement for this metric, so
                    there is no ranking to offer. An empty list here is the
                    honest answer — the server would otherwise hand back twelve
                    tied zeroes.
                  </Body>
                )}
              </View>

              {/* The one WRITE on this screen: the workspace default for new
                  campaigns. Same admin floor as the analysis read (both
                  routes are family:admin), so it renders exactly where the
                  evidence for the decision is. */}
              <SendTimeDefaultCard />

              {totals ? (
                <Card style={{ gap: 6 }}>
                  <SectionHeading>What this is measured over</SectionHeading>
                  <Body>
                    {`${num(totals.sent)} sent · ${num(totals.delivered)} delivered · ${num(totals.opened)} opened · ${num(totals.clicked)} clicked, across ${totals.measuredCells} of the week's 168 hours.`}
                  </Body>
                  <Body tone="muted">
                    {totals.modelledSubscribers > 0
                      ? `${num(totals.modelledSubscribers)} subscribers have a modelled best hour. Hours are UTC; each window also shows your device's local time.`
                      : "No subscriber has a modelled best hour yet. Hours are UTC; each window also shows your device's local time."}
                  </Body>
                </Card>
              ) : null}
            </>
          ) : null}
        </QueryStates>

        {/* OUTSIDE QueryStates on purpose: the scoped week comes from a
            different endpoint, and a workspace with nothing sent yet — the
            exact case QueryStates renders as empty — can still have a segment
            with modelled open history. */}
        <SendTimeSegmentScopeCard />
      </ScrollView>
    </SafeAreaView>
  );
}
