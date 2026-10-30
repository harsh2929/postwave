/**
 * Subscriber detail screen.
 *
 * Header card (name, avatar, human status label, joined + last active,
 * engagement gauge), action row, lifetime stats, 30-day sparkline, tags,
 * LIST MEMBERSHIPS, consent, details, custom fields, then a virtualised
 * activity timeline paged by the API's opaque cursor.
 *
 * Behaviours worth calling out:
 *
 *  - The writes live in useSubscriberProfileActions, including the fix that
 *    Unsubscribe now writes `blocklisted` (what desktop and web write) and
 *    not `disabled`.
 *  - Actions are gated on ROLE as well as connectivity. A viewer used to see
 *    enabled buttons that produced a scary confirm and then a raw 403.
 *  - Timeline auto-paging stops at a ceiling; past it, loading more is a
 *    deliberate tap rather than an unbounded accumulation in JS memory.
 *
 * Honest fallback: 404 / 405 / 501 from the gateway flips the timeline
 * (and gauge / sparkline / stats) into a muted "unavailable" notice; any
 * other failure is a retryable error, never a fake "no activity".
 */
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, RefreshControl, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { SubscriberTimelineEvent } from "@/api/mobileParity";
import { cachedSessionNotice } from "@/components/CachedSessionNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AddToListModal } from "@/components/subscriber/AddToListModal";
import { SubscriberResubscribeReview } from "@/components/subscriber/SubscriberResubscribeReview";
import { SubscriberDetailChrome } from "@/components/subscriber/SubscriberDetailChrome";
import { TagsModal } from "@/components/subscriber/SubscriberDetailModals";
import {
  SubscriberDetailOverview,
  SubscriberTimelineFooter,
} from "@/components/subscriber/SubscriberDetailSections";
import { TimelineEvent } from "@/components/subscriber/TimelineEvent";
import { TimelineFilterBar } from "@/components/subscriber/TimelineFilterBar";
import { useCachedRowSeed } from "@/hooks/useCachedRowSeed";
import { useEntityActivity } from "@/hooks/useEntityActivity";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useSubscriber } from "@/hooks/useSubscribers";
import { useSubscriberEmailActions } from "@/hooks/useSubscriberEmailActions";
import { useSubscriberProfileActions } from "@/hooks/useSubscriberProfileActions";
import { useSubscriberTimeline } from "@/hooks/useSubscriberTimeline";
import { useTimelineFacet } from "@/hooks/useTimelineFacet";
import { useRecordLastViewed } from "@/hooks/useActivityCursor";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { subscriberQueryRootKey } from "@/lib/subscriberQueryKeys";
import { useAuthStore } from "@/store/auth";
import { TIMELINE_AUTO_PAGE_LIMIT } from "@/api/subscriberTimeline";
import { trackSubscriberProfileViewed } from "@/lib/audienceTelemetry";
import { goBackOr } from "@/lib/nav";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { subscriberDetailGates } from "@/lib/subscriberDetailGates";
import { uiStatusToEngine } from "@/lib/subscriberStatus";
import { useTheme } from "@/lib/theme";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

/**
 * Module-level so the seed's memo key is stable — an inline array literal
 * would be a new identity on every render.
 */
const SUBSCRIBER_SEED_FIELDS = ["email"] as const;

export default function SubscriberDetail() {
  useScreenViewed("subscriber-detail");
  const { t } = useTheme();
  const online = useIsOnline();
  const onlineGate = useOnlineQueryGate();
  const authMode = useAuthStore((s) => s.mode);
  const gateNotice = cachedSessionNotice({
    gateEnabled: onlineGate.enabled,
    hasTenant: Boolean(onlineGate.tenantId),
    surface: "subscriber",
  });
  // THREE authorization boundaries meet on this screen and none of them is a
  // rounding of another: edit (editor+), add-to-list (editor+, and queued
  // offline), and the consent ledger (admin only). The policy and the
  // ordering of the "why not" sentence are unit-tested in the lib.
  const gates = subscriberDetailGates({
    online,
    hasWriteRole: canAccessMinimumRole(
      "editor",
      onlineGate.effectiveRole,
      authMode,
    ),
    hasAdminRole: canAccessMinimumRole(
      "admin",
      onlineGate.effectiveRole,
      authMode,
    ),
    hasSessionNotice: Boolean(gateNotice),
  });
  const canMutate = gates.canMutate;
  const canAddToList = gates.canAddToList;
  const addToListUnavailableReason = gates.addToListUnavailableReason;
  const canReadConsent = gates.canReadConsent;
  const unavailableReason = gates.unavailableReason;

  const { id } = useLocalSearchParams<{ id: string }>();

  // Cross-device continuity: tell the server this is where the user is,

  // so their other devices can offer "Continue". Best-effort and silent.

  useRecordLastViewed("subscriber", id);
  const sub = useSubscriber(id);
  // The list row that led here is still in the cache (and, because detail
  // routes are siblings in the Tabs navigator, the list screen is still
  // mounted). Read the address off it so the header is not blank while the
  // detail request is in flight.
  const headerSeed = useCachedRowSeed(
    subscriberQueryRootKey(onlineGate.tenantId),
    id,
    SUBSCRIBER_SEED_FIELDS,
  );
  // Offer this profile to Handoff so an operator can continue on their Mac
  // (SHELL#31). Deliberately NOT Spotlight-indexed: a subscriber's title is a
  // person's identity and the index outlives the session — see
  // lib/entityActivity.ts.
  useEntityActivity({
    entity: "subscriber",
    id,
    title: sub.data?.email ?? headerSeed.email,
  });

  // One event per profile OPEN. The audience cluster emitted nothing at all,
  // so "does anyone open a subscriber on their phone?" was unanswerable. The
  // subscriber id is deliberately NOT sent.
  useEffect(() => {
    if (id) trackSubscriberProfileViewed("list");
  }, [id]);

  const [tagsOpen, setTagsOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  // Resubscribe routes through a CONSENT REVIEW, matching desktop: the sheet
  // collects the evidence envelope and the mutation refuses a partial one.
  const [consentOpen, setConsentOpen] = useState(false);
  // Auto-paging stops at a ceiling; beyond it the user asks explicitly.
  const [pageCeiling, setPageCeiling] = useState(TIMELINE_AUTO_PAGE_LIMIT);

  // Query + derived projections live in hooks/useSubscriberTimeline; the
  // screen keeps only the auto-page ceiling policy above.
  const { timeline, unavailable, timelineFailed, stats, loadedPages, events } =
    useSubscriberTimeline(id);

  const currentStatus = stats?.current_status ?? sub.data?.status;
  const actions = useSubscriberProfileActions({
    id,
    email: sub.data?.email,
    currentStatus,
    currentTags: sub.data?.tags,
    canMutate,
  });

  // Tap copies, long press shares — see the hook for why that is the right
  // way round on a support call.
  const emailActions = useSubscriberEmailActions(sub.data?.email);

  const refreshing =
    (sub.isRefetching && !sub.isLoading) ||
    (timeline.isRefetching && !timeline.isLoading);
  const onRefresh = useCallback(() => {
    if (gateNotice) return;
    setPageCeiling(TIMELINE_AUTO_PAGE_LIMIT);
    void sub.refetch();
    void timeline.refetch();
  }, [gateNotice, sub, timeline]);

  const visibleEvents = timelineFailed || unavailable ? [] : events;
  // Facet over the LOADED pages only — the endpoint has no type parameter,
  // which is why TimelineFilterBar renders a scope disclosure beside the
  // control and the footer gets its own empty-facet sentence.
  const facets = useTimelineFacet(visibleEvents, Boolean(timeline.hasNextPage));
  const timelineRows = facets.rows;
  const keyExtractor = useCallback(
    (e: SubscriberTimelineEvent, i: number) =>
      `${e.occurred_at}-${e.type}-${i}`,
    [],
  );
  const renderItem = useCallback(
    ({ item, index }: { item: SubscriberTimelineEvent; index: number }) => (
      <TimelineEvent
        event={item}
        isFirst={index === 0}
        isLast={index === timelineRows.length - 1}
      />
    ),
    [timelineRows.length],
  );

  const hasNextPage = Boolean(timeline.hasNextPage);
  const fetchingNext = timeline.isFetchingNextPage;
  const fetchNextPage = timeline.fetchNextPage;
  const autoPagingExhausted =
    hasNextPage && !fetchingNext && loadedPages >= pageCeiling;
  const onEndReached = useCallback(() => {
    if (!hasNextPage || fetchingNext || loadedPages >= pageCeiling) return;
    void fetchNextPage();
  }, [fetchNextPage, fetchingNext, hasNextPage, loadedPages, pageCeiling]);
  const onLoadOlder = useCallback(() => {
    setPageCeiling((n) => n + TIMELINE_AUTO_PAGE_LIMIT);
    void fetchNextPage();
  }, [fetchNextPage]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Subscriber"
        // Seeded from the list row the user just tapped so the header carries
        // an identity on the FIRST frame instead of an empty subtitle for the
        // whole detail round trip. The real value wins the moment it lands.
        subtitle={sub.data?.email ?? headerSeed.email}
        onBack={() => goBackOr("/(tabs)/subscribers")}
      />
      <FlatList
        {...MOBILE_LIST_PERF_PROPS}
        data={timelineRows}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        onEndReached={
          timelineRows.length > 0 && hasNextPage ? onEndReached : undefined
        }
        onEndReachedThreshold={0.5}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            enabled={!gateNotice}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          <View>
            <SubscriberDetailChrome
              isOnline={online}
              gateNotice={gateNotice}
              hasData={Boolean(sub.data)}
              isLoading={sub.isLoading}
              isError={sub.isError}
              error={sub.error}
              onRetry={() => void sub.refetch()}
            />
            {sub.data ? (
              <SubscriberDetailOverview
                subscriberId={id!}
                subscriber={sub.data}
                stats={stats}
                unavailable={unavailable}
                timelineFailed={timelineFailed}
                isOnline={online}
                canMutate={canMutate}
                canAddToList={canAddToList}
                {...(unavailableReason ? { unavailableReason } : {})}
                {...(addToListUnavailableReason
                  ? { addToListUnavailableReason }
                  : {})}
                isUpdatingTags={actions.tagsPending}
                isSettingStatus={actions.statusPending}
                isSuppressing={actions.suppressPending}
                isTimelineFetching={timeline.isFetching}
                canReadConsent={canReadConsent}
                onCopyEmail={emailActions.onCopyEmail}
                onShareEmail={emailActions.onShareEmail}
                onEditTags={() => setTagsOpen(true)}
                onAddToList={() => setListOpen(true)}
                onUnsubscribe={actions.onUnsubscribe}
                onResubscribe={() => setConsentOpen(true)}
                onRemoveTag={actions.onRemoveTag}
                onBackToSubscribers={() => goBackOr("/(tabs)/subscribers")}
                onRetryTimeline={() => void timeline.refetch()}
              />
            ) : null}
            {/* Directly above the feed it filters — and carrying the note
                that keeps an empty facet from reading as a fact about the
                person rather than about the pages loaded. */}
            {/* Self-gating: the bar renders nothing while no events are
                loaded, so the unavailable / failed / not-yet-loaded cases
                need no extra branch here. */}
            <TimelineFilterBar
              facet={facets.facet}
              onChange={facets.setFacet}
              counts={facets.counts}
              shown={timelineRows.length}
              loaded={facets.loaded}
              unclassified={facets.unclassified}
              hasMore={hasNextPage}
            />
          </View>
        }
        ListFooterComponent={
          <SubscriberTimelineFooter
            hasSubscriber={Boolean(sub.data)}
            isSuppressed={uiStatusToEngine(currentStatus) === "blocklisted"}
            unavailable={unavailable}
            timelineLoading={timeline.isLoading}
            eventsCount={events.length}
            shownCount={timelineRows.length}
            facetEmptyMessage={facets.emptyMessage}
            timelineFailed={timelineFailed}
            fetchingNext={fetchingNext}
            suppressPending={actions.suppressPending}
            canSuppress={canMutate}
            {...(unavailableReason
              ? { suppressDisabledReason: unavailableReason }
              : {})}
            onSuppress={actions.onSuppress}
            autoPagingExhausted={autoPagingExhausted}
            onLoadOlder={onLoadOlder}
          />
        }
      />

      {sub.data ? (
        <TagsModal
          visible={tagsOpen}
          onClose={() => setTagsOpen(false)}
          subscriberId={id!}
          email={sub.data.email}
          currentTags={Array.isArray(sub.data.tags) ? sub.data.tags : []}
          t={t}
        />
      ) : null}

      {sub.data && id ? (
        <SubscriberResubscribeReview
          visible={consentOpen}
          id={id}
          email={sub.data.email}
          onClose={() => setConsentOpen(false)}
        />
      ) : null}

      {sub.data ? (
        <AddToListModal
          visible={listOpen}
          onClose={() => setListOpen(false)}
          subscriberId={id!}
          email={sub.data.email}
          t={t}
        />
      ) : null}
    </SafeAreaView>
  );
}
