/**
 * Notification inbox — the mobile "bell".
 *
 * What this pass fixed:
 *
 *  - ALL/UNREAD filter. The backend has always accepted `?unread=true`
 *    (notification_feed.go List), and mobile rendered one flat list, so a
 *    backlog could only be scrolled past, never worked.
 *  - The pull-to-refresh spinner no longer self-triggers. `refreshing` was bound
 *    to `isFetching`, so every background poll — once a minute, forever — drove
 *    the RefreshControl into its spinning state: a phantom gesture the user
 *    never made.
 *  - Marking read is optimistic. It used to cost a POST plus a full refetch
 *    before the blue dot cleared, with the POST's result discarded entirely.
 *  - Opening the inbox costs ONE request. The mount-time "seen" write used to
 *    invalidate the whole feed, so every open was GET → POST → GET and the list
 *    re-rendered under the user's thumb.
 *  - A notification whose deep_link isn't a route-map entity no longer does
 *    nothing: it explains itself, and offers the web admin when it can.
 *
 * NativeWind v4 gotcha: rows use STATIC style Pressables.
 */
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Pressable, SectionList, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { EVENTS } from "@postwave/telemetry";

import {
  markAllNotificationsRead,
  markFeedAllRead,
  markFeedItemRead,
  markFeedSeen,
  markNotificationRead,
  markNotificationsSeen,
  NOTIFICATION_FEED_LIMIT,
  type MobileNotification,
  type NotificationFeed,
} from "@/api/notifications";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { useConfirm } from "@/components/ConfirmSheet";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SegmentedControl } from "@/components/SegmentedControl";
import { StaleDataBanner } from "@/components/StaleDataBanner";
import { SwipeableRow } from "@/components/SwipeableRow";
import {
  InboxDayHeader,
  InboxEmpty,
  NotificationRow,
} from "@/components/notifications/InboxRows";
import { groupByDay } from "@/components/notifications/inboxGrouping";
import { useToast } from "@/components/Toast";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useNavigateTo } from "@/hooks/useNavigateTo";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  notificationFeedKey,
  useNotificationFeed,
  type NotificationFilter,
} from "@/hooks/useNotificationFeed";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { routeForEntityLink } from "@/lib/deepLinks";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { MOBILE_SECTION_LIST_PERF_PROPS } from "@/lib/listPerf";
import { useMotion } from "@/lib/motion";
import { goBackOrMore } from "@/lib/nav";
import { targetFromHref } from "@/lib/navigateTo";
import { resolveNotificationTap } from "@/lib/notificationInboxTap";
import { feedWindowNotice } from "@/lib/shellNotices";
import { SCREEN_SCROLL_PADDING_BOTTOM } from "@/lib/shellStyleTokens";
import { track } from "@/lib/telemetry";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const FILTERS: readonly { value: NotificationFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
];

/** Per-route boundary: a malformed feed item degrades this screen, not the app. */
export { AppErrorBoundary as ErrorBoundary };

/**
 * Both feed caches — "all" and "unread" — captured as [key, value] pairs
 * BEFORE an optimistic write.
 *
 * Module scope rather than a hook: it closes over nothing React-owned, and the
 * capture/restore pair was written out twice inside the screen component,
 * where the second copy is exactly the kind that drifts from the first.
 */
function feedSnapshots(
  queryClient: QueryClient,
  tenantId: string | null,
): readonly (readonly [(string | null)[], NotificationFeed | undefined])[] {
  return (["all", "unread"] as const).map(
    (key) =>
      [
        notificationFeedKey(tenantId, key),
        queryClient.getQueryData<NotificationFeed>(
          notificationFeedKey(tenantId, key),
        ),
      ] as const,
  );
}

/** Put back exactly what was on screen before a failed optimistic write. */
function restoreFeedSnapshots(
  queryClient: QueryClient,
  snapshots: readonly (readonly [
    (string | null)[],
    NotificationFeed | undefined,
  ])[],
): void {
  for (const [key, snapshot] of snapshots) {
    queryClient.setQueryData(key, snapshot);
  }
}

export default function NotificationsScreen() {
  useScreenViewed("notifications");
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const navigateTo = useNavigateTo();
  const tenantId = gate.tenantId;
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();

  const [filter, setFilter] = useState<NotificationFilter>("all");
  const { animateLayout } = useMotion();

  const feed = useNotificationFeed(filter);
  const items = useMemo(() => (Array.isArray(feed.data?.items) ? feed.data?.items : []), [feed.data]);
  const unread = feed.data?.unread_count ?? 0;
  // Day boundaries rather than 40 rows each saying "6d ago". "Today" is
  // resolved against the moment the FEED settled, not the render clock, so
  // every heading agrees with the rows underneath it and re-buckets exactly
  // once per fetch instead of on every unrelated re-render.
  const sections = useMemo(
    () =>
      groupByDay(
        items,
        (item) => item.created_at,
        feed.dataUpdatedAt || Date.now(),
      ),
    [items, feed.dataUpdatedAt],
  );

  const patchCaches = useCallback(
    (
      patch: (
        feed: NotificationFeed | undefined,
      ) => NotificationFeed | undefined,
    ) => {
      for (const key of ["all", "unread"] as const) {
        queryClient.setQueryData<NotificationFeed>(
          notificationFeedKey(tenantId, key),
          (current) => patch(current) ?? current,
        );
      }
    },
    [queryClient, tenantId],
  );

  // Clear the unseen badge on open. Stamped LOCALLY: `seen_at` is not rendered
  // anywhere, so the old invalidate-the-world refetch could not reveal anything
  // and only cost a second full page plus a list jump.
  useEffect(() => {
    if (!gate.enabled || !tenantId) return;
    void markNotificationsSeen()
      .then(() => patchCaches((f) => markFeedSeen(f, new Date().toISOString())))
      // A failed "seen" write is genuinely not worth interrupting the user
      // over — the badge simply stays until the next successful open — but it
      // must not be an UNOBSERVED promise rejection either.
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, gate.enabled]);

  const readOne = useCallback(
    (item: MobileNotification) => {
      if (item.read_at) return;
      const now = new Date().toISOString();
      const snapshots = feedSnapshots(queryClient, tenantId);
      patchCaches((f) => markFeedItemRead(f, item.id, now));
      void markNotificationRead(item.id).catch(() => {
        // Roll back to exactly what was on screen before, then say so. A
        // silently-reappearing dot reads as a bug.
        restoreFeedSnapshots(queryClient, snapshots);
        toast({ kind: "error", message: "Couldn't mark that read." });
      });
    },
    [patchCaches, queryClient, tenantId, toast],
  );

  const open = useCallback(
    (item: MobileNotification) => {
      haptics.tap();
      // Four grammars, topic table first, shared with push — see
      // lib/notificationInboxTap for why the decision lives outside this file.
      const { route, plan, telemetry } = resolveNotificationTap(
        item,
        routeForEntityLink,
      );
      const target = targetFromHref(route);
      // The inbox emitted nothing, so "how many taps land nowhere" — the exact
      // question this screen's dead-tap bug raised — was unanswerable.
      track(EVENTS.MOBILE_NOTIFICATION_OPENED, telemetry);
      // Only spend the read receipt when the tap actually goes somewhere —
      // otherwise the user loses the item AND gets nothing.
      if (plan.kind !== "unsupported") readOne(item);
      switch (plan.kind) {
        case "in-app":
          // Three notifications about the same campaign used to stack three
          // identical screens; navigateTo replaces when we are already there.
          if (target) navigateTo(target);
          return;
        case "web":
          toast({
            kind: "info",
            message: "That opens on the web admin.",
            action: {
              label: "Open",
              onPress: () => void Linking.openURL(plan.url),
            },
          });
          return;
        case "unsupported":
          toast({
            kind: "warning",
            message:
              "This notification points somewhere the app can't open yet.",
          });
          return;
        default:
          return;
      }
    },
    [navigateTo, readOne, toast],
  );

  const markAll = useCallback(async () => {
    // Irreversible AND it can clear a backlog the user has never seen — the
    // server's read-all covers every unread row, not just the loaded page — so
    // the confirmation names the count.
    const ok = await confirm({
      title: "Mark everything read?",
      message:
        "This clears the unread state for every notification in this workspace, including any not shown here.",
      confirmLabel: "Mark all read",
      consequence: `${unread} unread notification${unread === 1 ? "" : "s"} will be cleared.`,
    });
    if (!ok) return;
    const now = new Date().toISOString();
    const snapshots = feedSnapshots(queryClient, tenantId);
    patchCaches((f) => markFeedAllRead(f, now));
    try {
      await markAllNotificationsRead();
      haptics.success();
      toast({ kind: "success", message: "All notifications marked read." });
    } catch {
      restoreFeedSnapshots(queryClient, snapshots);
      toast({ kind: "error", message: "Couldn't mark everything read." });
    }
  }, [confirm, patchCaches, queryClient, tenantId, toast, unread]);

  // Bound to the GESTURE, not to isFetching: a background poll — this feed
  // refetches once a minute, forever — must never animate a control the user
  // did not touch. That was hand-rolled here first; the shared hook is the
  // same contract plus the completion tick every other deliberate action in
  // the app answers with.
  const refetchFeed = feed.refetch;
  const refresh = useManualRefresh([refetchFeed]);

  const updatedAt = feed.dataUpdatedAt
    ? `Updated ${relativeTime(feed.dataUpdatedAt)}`
    : undefined;

  // The feed endpoint has no cursor (Repo.List takes unreadOnly + limit only),
  // so a full page is the end of what mobile can ever show. Say so instead of
  // letting the list stop dead — especially since "Mark all read" clears rows
  // beyond this window that the user has never seen.
  const windowNotice = feed.isSuccess
    ? feedWindowNotice(items.length, NOTIFICATION_FEED_LIMIT)
    : null;

  // useCallback so the filter control and the ticking relative timestamps do
  // not hand the SectionList a fresh renderItem identity on every render and
  // re-render every mounted row (LOVE#39).
  const renderNotification = useCallback(
    ({ item }: { item: MobileNotification }) => (
      <SwipeableRow
        accessibilityLabel={item.title}
        {...(item.read_at
          ? {}
          : {
              right: [
                {
                  label: "Mark read",
                  kind: "primary" as const,
                  onPress: () => readOne(item),
                },
              ],
            })}
      >
        <NotificationRow item={item} onPress={() => open(item)} />
      </SwipeableRow>
    ),
    [open, readOne],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Notifications"
        {...(updatedAt ? { subtitle: updatedAt } : {})}
        onBack={goBackOrMore}
        right={
          unread > 0 ? (
            <Pressable
              onPress={() => void markAll()}
              accessibilityRole="button"
              accessibilityLabel={`Mark all read. ${unread} unread`}
              hitSlop={8}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text
                {...typeCap("callout")}
                style={{
                  color: t.accent,
                  fontFamily: FONT.medium,
                  ...typeStyle("callout"),
                }}
              >
                Mark all read
              </Text>
            </Pressable>
          ) : undefined
        }
      />

      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <SegmentedControl
          options={FILTERS.map((option) =>
            option.value === "unread" && unread > 0
              ? { ...option, badge: unread }
              : option,
          )}
          value={filter}
          onChange={(next) => {
            haptics.tap();
            // All → Unread does not filter rows in place: it swaps the whole
            // SectionList for a different query's result, day headings and
            // all, while the "Mark all read" affordance appears or vanishes in
            // the header above. Animating the layout pass is what makes that a
            // filter rather than a screen replacement.
            animateLayout("enter");
            setFilter(next);
          }}
          accessibilityLabel="Notification filter"
        />
      </View>

      {/* A failed background poll must not silently keep showing stale rows. */}
      {feed.isError && items.length > 0 ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <StaleDataBanner onRetry={() => void feed.refetch()} />
        </View>
      ) : null}

      <SectionList
        {...MOBILE_SECTION_LIST_PERF_PROPS}
        sections={sections}
        keyExtractor={(n) => n.id}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <InboxDayHeader title={section.title} />
        )}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: SCREEN_SCROLL_PADDING_BOTTOM,
          paddingTop: 4,
        }}
        refreshing={refresh.refreshing}
        onRefresh={refresh.onRefresh}
        ListFooterComponent={
          windowNotice ? <FeedWindowNotice message={windowNotice} /> : null
        }
        ListEmptyComponent={
          <InboxEmpty
            gateEnabled={gate.enabled}
            isError={feed.isError}
            error={feed.error}
            isLoading={feed.isLoading}
            filter={filter}
            onRetry={() => void feed.refetch()}
          />
        }
        renderItem={renderNotification}
      />
    </SafeAreaView>
  );
}

/**
 * Footer stating the page boundary. `accessibilityRole="text"` (rather than a
 * silent decorative line) because the boundary is the reason a screen-reader
 * user's swipe-to-next stops, and hearing nothing there is the same bug as
 * seeing nothing.
 */
function FeedWindowNotice({ message }: { message: string }) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityRole="text"
      {...typeCap("label")}
      style={{
        color: t.fgSubtle,
        fontFamily: FONT.regular,
        ...typeStyle("label"),
        textAlign: "center",
        paddingTop: 16,
        paddingHorizontal: 8,
      }}
    >
      {message}
    </Text>
  );
}
