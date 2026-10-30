/**
 * Subscribers list screen — search + status filter + paginated browse.
 *
 * Filter chips are driven by src/lib/subscriberStatus.ts, the single
 * engine↔UI vocabulary shared with desktop and web. There is deliberately
 * no "Bounced" chip: the engine has no bounced status, and the old chip
 * sent `status=blocklisted`, so it returned SUPPRESSED contacts under a
 * label that promised bounces.
 *
 * Pull-to-refresh means "start over from the top": the infinite-query
 * cache is truncated to page 1 before the refetch, so a user twenty pages
 * deep pays one request rather than twenty (TanStack refetches every
 * loaded page by design).
 *
 * Tapping a row navigates to /subscribers/[id]; swiping a row reveals
 * Suppress (with an undo toast) and Tag, both of which are also published
 * to VoiceOver as row actions. LONG-PRESSING a row enters multi-select, which
 * withdraws the swipe actions and turns taps into selection — see
 * src/components/subscriber/SubscriberRow.tsx for the full gesture contract
 * and src/lib/subscriberSelection.ts for which verbs a phone offers and why.
 *
 * The header's + opens CreateSubscriberSheet. Mobile used to document a stance
 * of "look subscribers up rather than create them"; that was wrong for the one
 * device that is present when a new address appears. It creates the server's
 * `unconfirmed` shape and says so — anything sendable needs a reviewed consent
 * envelope that does not belong on a phone keyboard.
 */
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  CachedSessionNotice,
  cachedSessionNotice,
} from "@/components/CachedSessionNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { ScrollToTop } from "@/components/ScrollToTop";
import { AudienceGrowthCard } from "@/components/subscriber/AudienceGrowthCard";
import { CreateSubscriberSheet } from "@/components/subscriber/CreateSubscriberSheet";
import { HeaderAction } from "@/components/deliverability/HeaderAction";
import { SubscriberBulkLayer } from "@/components/subscriber/SubscriberBulkLayer";
import type { SubscriberListRow } from "@/components/subscriber/SubscriberRow";
import { SubscribersListEmpty } from "@/components/subscriber/SubscribersListEmpty";
import { SubscribersHeaderRegion } from "@/components/subscriber/SubscribersHeaderRegion";
import { useDebounced } from "@/hooks/useDebounced";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useSubscriberViewControls } from "@/hooks/useSubscriberViewControls";
import { useSubscribersActions } from "@/hooks/useSubscribersActions";
import { useSubscribersPaging } from "@/hooks/useSubscribersPaging";
import { useSubscribers } from "@/hooks/useSubscribers";
import { useSubscriberRowSuppress } from "@/hooks/useSubscriberRowSuppress";
import { useAudienceSearchTelemetry } from "@/hooks/useAudienceSearchTelemetry";
import { relativeTime } from "@/lib/format";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { useMotion } from "@/lib/motion";
import { trackAudienceFilter } from "@/lib/audienceTelemetry";
import { subscriberCountLine } from "@/lib/subscriberCountLine";
import { flattenSubscriberPages } from "@/lib/subscriberQueryCache";
import { subscriberSortByKey } from "@/lib/subscriberSort";
import {
  statusFilterByKey,
  statusFilterNoun,
} from "@/lib/subscriberStatus";
import { useTheme } from "@/lib/theme";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

function RowSeparator() {
  return <View style={{ height: 8 }} />;
}

export default function Subscribers() {
  const { t } = useTheme();
  // LOVE#7: the chip/segment swaps below reflow the whole list. Called in the
  // handler, never an effect — see useSubscriberViewControls for why.
  const { animateLayout } = useMotion();
  const listRef = useRef<FlatList<SubscriberListRow> | null>(null);
  const onlineGate = useOnlineQueryGate();
  const subscribersGateNotice = cachedSessionNotice({
    gateEnabled: onlineGate.enabled,
    hasTenant: Boolean(onlineGate.tenantId),
    surface: "subscribers",
  });
  // A `q` deep-link param (from a scanned/shared email, or a Siri/desktop
  // hand-off) seeds the search so the operator lands on that person. When the
  // search finds nobody, the empty state can now hand that same term straight
  // to the create sheet instead of dead-ending.
  const params = useLocalSearchParams<{ q?: string }>();
  const initialQ = typeof params.q === "string" ? params.q : "";
  const [q, setQ] = useState(initialQ);
  const [filterKey, setFilterKey] = useState("all");
  const debouncedQ = useDebounced(q, 300);
  const activeFilter = statusFilterByKey(filterKey);
  // Remembered sort / archived / growth-card state, plus the layout animation
  // that goes with changing any of them (LOVE#7). See the hook.
  const view = useSubscriberViewControls();
  const includeArchived = view.includeArchived;
  const [sortOpen, setSortOpen] = useState(false);
  const activeSort = subscriberSortByKey(view.sortKey);
  const subs = useSubscribers(
    debouncedQ,
    activeFilter.engineStatus,
    { sort: activeSort.sort, order: activeSort.order },
    includeArchived,
  );
  // Suppress-from-row, with its receipt and undo. The gate closes it so a
  // cached session can't fire a compliance write.
  const onSuppressRow = useSubscriberRowSuppress(!subscribersGateNotice);
  // If we're re-navigated here with a fresh `q` (e.g. a second QR scan / share
  // hand-off while already on this screen), adopt it into the search box.
  const paramQ = typeof params.q === "string" ? params.q : "";
  useEffect(() => {
    if (paramQ && paramQ !== q) setQ(paramQ);
    // Only react to the incoming param, not every keystroke in `q`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramQ]);

  const isSearching = debouncedQ.trim().length > 0;

  // Flattening lives in lib so "absence is not zero" for `total` is unit-tested
  // rather than re-derived inside a screen.
  const { rows: allRows, serverTotal } = useMemo(
    () => flattenSubscriberPages<SubscriberListRow>(subs.data),
    [subs.data],
  );

  const keyExtractor = useCallback(
    (item: SubscriberListRow, idx: number) => item.id ?? `${item.email}-${idx}`,
    [],
  );

  // Multi-select, create, and the two DIFFERENT role gates they need — see
  // the hook's doc for why bulk is admin-only while create reaches editors.
  const actions = useSubscribersActions({
    rows: allRows,
    gated: Boolean(subscribersGateNotice),
    effectiveRole: onlineGate.effectiveRole,
    searchTerm: debouncedQ,
    onSuppress: onSuppressRow,
  });
  const selection = actions.selection;

  // A saved segment drives the list through the same two pieces of state
  // the chips do. `activeSegmentId` is cleared by any manual edit below, so
  // the chip can never stay lit over a query the user has since changed.
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const applySegment = useCallback(
    (id: string, nextQ: string, nextStatusKey: string) => {
      animateLayout("enter");
      setQ(nextQ);
      setFilterKey(nextStatusKey);
      setActiveSegmentId(id);
      trackAudienceFilter(nextStatusKey, "segment");
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
    },
    [animateLayout],
  );
  const onQueryChange = useCallback((next: string) => {
    // Deliberately NOT animated: the query is debounced and the results
    // change under the user's own typing. Animating each settle would move
    // the list while a finger is on the keyboard.
    setQ(next);
    setActiveSegmentId(null);
  }, []);
  const onFilterChange = useCallback(
    (key: string) => {
      // The densest interaction on the busiest list in the app. Every row
      // below the chips is replaced by a different set, and without this the
      // whole column snaps to its new positions in a single frame.
      animateLayout("enter");
      setFilterKey(key);
      setActiveSegmentId(null);
      trackAudienceFilter(key, "chip");
    },
    [animateLayout],
  );

  // Scroll-to-end paging and pull-to-refresh, including the truncate-to-page-1
  // rule that keeps one pull from costing twenty round trips.
  const paging = useSubscribersPaging({
    listRef,
    tenantId: onlineGate.tenantId,
    query: debouncedQ,
    status: activeFilter.engineStatus,
    sort: activeSort,
    includeArchived,
    gated: Boolean(subscribersGateNotice),
    hasNextPage: Boolean(subs.hasNextPage),
    isFetchingNextPage: subs.isFetchingNextPage,
    fetchNextPage: subs.fetchNextPage,
    refetch: subs.refetch,
  });

  // These screens are routinely resumed hours later from the background, so
  // say how old the numbers are rather than presenting them as live.
  const freshness = relativeTime(subs.dataUpdatedAt || undefined, {
    fallback: "",
  });
  const showCount = !subs.isLoading && !subs.isError && allRows.length > 0;
  // The growth chart describes the ACTIVE audience; showing it above a list
  // that has been widened with soft-deleted rows would put two different
  // populations on one screen without saying so.
  const showGrowth =
    !subscribersGateNotice &&
    !isSearching &&
    filterKey === "all" &&
    !includeArchived;
  // One `subscriber.searched` per settled term — length + result count only.
  // Nobody could previously tell whether search is used, let alone how often
  // it comes back empty.
  useAudienceSearchTelemetry(debouncedQ, serverTotal, !subs.isFetching);
  const noun = statusFilterNoun(filterKey);
  // "12 unsubscribed subscribers" / "3 results" / "Showing 25 of 1,340
  // subscribers". The rules live in src/lib/subscriberCountLine.ts so the
  // "never present one page as the workspace" invariant is unit-tested.
  const countLine = subscriberCountLine({
    loaded: allRows.length,
    serverTotal,
    isSearching,
    filterNoun: noun,
    hasNextPage: Boolean(subs.hasNextPage),
  });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      {/* The field below filters SUBSCRIBERS; the magnifier opens the global
          palette, so search is reachable from app chrome on every tab. */}
      <ScreenHeader
        title="Subscribers"
        onSearch
        right={
          actions.canCreate ? (
            <HeaderAction
              label="+"
              accessibilityLabel="Add a subscriber"
              onPress={actions.openCreate}
            />
          ) : null
        }
      />
      {/* Re-pressing the Subscribers tab returns to the top — the universal
          iOS gesture, and previously unimplemented on this tab. */}
      <ScrollToTop targetRef={listRef} />
      <SubscribersHeaderRegion
        query={debouncedQ}
        draftQuery={q}
        onQueryChange={onQueryChange}
        resultCount={
          isSearching && typeof serverTotal === "number"
            ? serverTotal
            : undefined
        }
        filterKey={filterKey}
        onFilterChange={onFilterChange}
        countLine={showCount ? countLine : ""}
        freshness={freshness}
        sortKey={view.sortKey}
        sortOpen={sortOpen}
        onSortOpen={() => setSortOpen(true)}
        onSortClose={() => setSortOpen(false)}
        onSortChange={(key) => {
          view.changeSort(key);
          listRef.current?.scrollToOffset({ offset: 0, animated: false });
        }}
        includeArchived={includeArchived}
        onToggleArchived={() => {
          view.toggleArchived();
          setActiveSegmentId(null);
          listRef.current?.scrollToOffset({ offset: 0, animated: false });
        }}
        engineStatus={activeFilter.engineStatus}
        sortField={activeSort.sort}
        sortOrder={activeSort.order}
        serverTotal={serverTotal}
        statusNoun={noun}
        listLoading={subs.isLoading || subs.isFetching}
        gateNotice={subscribersGateNotice}
        hasRows={allRows.length > 0}
        activeSegmentId={activeSegmentId}
        onApplySegment={applySegment}
        canEditSavedViews={actions.canCreate}
      />
      <FlatList
        ref={listRef}
        {...MOBILE_LIST_PERF_PROPS}
        data={allRows}
        keyExtractor={keyExtractor}
        // With the search keyboard open, a single tap on a filter chip or a
        // subscriber row should act immediately. Without this the list defaults
        // to keyboardShouldPersistTaps="never", so the first tap is consumed
        // dismissing the keyboard and a second tap is needed to select/open.
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingTop: 4 }}
        ItemSeparatorComponent={RowSeparator}
        refreshControl={
          <RefreshControl
            refreshing={paging.manualRefresh}
            onRefresh={paging.onRefresh}
            enabled={!subscribersGateNotice}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          // "Is my list growing?" — the one audience question a row count
          // cannot answer. Hidden while searching or filtering, where the
          // workspace-wide trend is not what the operator is looking at, and
          // hidden behind the online gate like every other read.
          showGrowth ? (
            <AudienceGrowthCard
              expanded={view.growthOpen}
              onToggle={view.toggleGrowth}
            />
          ) : null
        }
        ListEmptyComponent={
          // The five-state ladder (loading / error / gated / filtered /
          // truly empty) lives in one reviewable component — its ORDER is
          // the behaviour, and it was previously a nested ternary here.
          <SubscribersListEmpty
            isLoading={subs.isLoading}
            isError={subs.isError}
            error={subs.error}
            gateNotice={subscribersGateNotice}
            query={debouncedQ}
            filterKey={filterKey}
            filterNoun={noun}
            onRetry={() => void subs.refetch()}
            onClearFilters={() => {
              onQueryChange("");
              onFilterChange("all");
            }}
            {...(actions.canCreate ? { onCreate: actions.openCreate } : {})}
          />
        }
        ListFooterComponent={
          subs.isFetchingNextPage ? (
            <View style={{ paddingVertical: 24, alignItems: "center" }}>
              <ActivityIndicator color={t.fgMuted} />
            </View>
          ) : null
        }
        renderItem={actions.renderRow}
        onEndReachedThreshold={0.5}
        onEndReached={paging.onEndReached}
      />
      {/* Renders nothing unless selection mode is on. */}
      <SubscriberBulkLayer
        selection={selection}
        loadedCount={actions.loadedIds.length}
        t={t}
      />
      <CreateSubscriberSheet
        visible={actions.createOpen}
        submitting={actions.createPending}
        // A search that found nobody is the most common way to land here, so
        // the term the operator already typed seeds the address.
        initialEmail={actions.createInitialEmail}
        online={actions.online}
        bulkSubmitting={actions.bulkPastePending}
        bulkResult={actions.bulkPasteResult}
        onClose={actions.closeCreate}
        onSubmit={actions.submitCreate}
        onSubmitBulk={actions.submitBulkPaste}
        t={t}
      />
    </SafeAreaView>
  );
}
