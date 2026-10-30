/**
 * Suppressions — triage "why didn't this person get my email?" end to end.
 *
 * What changed, and why:
 *
 *  - SEARCH REACHES THE SERVER. The endpoint has accepted `email=` (exact) and
 *    `q=` (prefix) since the A20 change; the screen filtered 50 cached rows
 *    client-side and told a tenant with 400k suppressions "Nothing matches"
 *    for ~99.99% of addresses. `classifySearchQuery` now decides which filter
 *    a given query can use.
 *  - THE TAXONOMY MATCHES THE SERVER'S. Five substring buckets became the
 *    eight canonical ones; `spam_trap` used to match no chip at all.
 *  - IT IS NO LONGER READ-ONLY. Un-suppress is a swipe (reversible → undo
 *    toast, not a confirm) and add is a header action. Both are admin-gated
 *    and online-only: a compliance write is never queued from a stale phone.
 *  - A ROW IS A DOOR. Tapping opens the audit timeline.
 *  - IT COVERS THREE CHANNELS, NOT ONE. Suppression is three different tables
 *    with three different reason vocabularies: email here, SMS on its own
 *    screen (which also owns quiet hours + keyword replies), and PUSH — the
 *    tenant-customer APNs/FCM/Web registry, not this app's Expo device table.
 *    See components/deliverability/SuppressionChannelNav.tsx.
 *  - THE CHANNEL AND THE REASON FILTER ARE REMEMBERED. An operator who always
 *    works the bounce bucket re-picked it on every visit, forever.
 *  - THE SORT IS HONEST ABOUT ITS SCOPE. Rows are ordered newest-first over
 *    what is LOADED, not the archive, and the footer says so rather than
 *    letting "newest" imply the newest record in the workspace.
 *  - THE ARCHIVE IS BROWSABLE. The read has always accepted `page=`; nothing
 *    here ever asked for a second one, so the 51st-newest suppression could
 *    only be reached by guessing its exact address in the search box. The
 *    footer now loads the next page, up to `SUPPRESSION_MAX_PAGES`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, RefreshControl, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { ChipRow } from "@/components/ChipRow";
import { PushSuppressionsPanel } from "@/components/deliverability/PushSuppressionsPanel";
import {
  SuppressionChannelNav,
  type SuppressionChannel,
} from "@/components/deliverability/SuppressionChannelNav";
import { CachedNotice } from "@/components/deliverability/CachedNotice";
import { AddSuppressionSheet } from "@/components/deliverability/AddSuppressionSheet";
import { MirrorFromEspSheet } from "@/components/deliverability/MirrorFromEspSheet";
import { SuppressionHeaderActions } from "@/components/deliverability/SuppressionHeaderActions";
import { SuppressionListFooter } from "@/components/deliverability/SuppressionListFooter";
import { SuppressionListRow } from "@/components/deliverability/SuppressionListRow";
import { SuppressionSelectionBar } from "@/components/deliverability/SuppressionSelectionBar";
import { SuppressionTrendHeader } from "@/components/deliverability/SuppressionTrendHeader";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SkeletonList } from "@/components/Skeleton";
import { useDebounced } from "@/hooks/useDebounced";
import { useSuppressionRowActions } from "@/hooks/useSuppressionRowActions";
import { useSuppressionSelection } from "@/hooks/useSuppressionSelection";
import { useListPreferences } from "@/hooks/useListPreferences";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useNowTicker } from "@/hooks/useNowTicker";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  useSuppressionList,
  useSuppressionTrend,
  type SuppressionRow,
} from "@/hooks/useSuppressionOps";
import { plural } from "@/lib/format";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { PUSH_PLATFORMS } from "@/lib/pushSuppressions";
import { goBackOrMore } from "@/lib/nav";
import {
  filterSuppressionRows,
  SUPPRESSION_DATE_WINDOWS,
  suppressionDateWindowByKey,
  suppressionEmptyCopy,
  type SuppressionDateWindow,
} from "@/lib/suppressionListRows";
import {
  classifySearchQuery,
  needsClientFilter,
  SUPPRESSION_FILTERS,
  suppressionFilterByKey,
  type ManualAddReason,
  type SuppressionFilter,
} from "@/lib/suppressionSearch";
import { suppressionScopeNoteWithWindow } from "@/lib/suppressionWindowScope";
import { useAuthStore } from "@/store/auth";
import { useMotion } from "@/lib/motion";
import { useTheme } from "@/lib/theme";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function Suppressions() {
  const { t } = useTheme();
  // LOVE#7 — see setFilter below.
  const { animateLayout } = useMotion();
  const gate = useOnlineQueryGate();
  const now = useNowTicker();
  useScreenViewed("suppressions");
  // A tap on a suppression hit in Search arrives with the hit's title as `q`, so the
  // list opens already narrowed to the thing the user picked. Without this the
  // query is silently discarded and the tap lands on an unfiltered list —
  // which reads as the search having done nothing.
  const params = useLocalSearchParams<{ q?: string; channel?: string }>();
  const [q, setQ] = useState(typeof params.q === "string" ? params.q : "");
  const debouncedQ = useDebounced(q, 300);
  // The channel, the reason bucket and the push platform survive the trip to a
  // detail screen and the next launch. `suppressionFilterByKey` guards a value
  // written by an older build so a stale preference can never leave the screen
  // filtering by a reason the taxonomy no longer has.
  const [prefs, setPrefs] = useListPreferences("suppressions", {
    channel: "email",
    reason: "all",
    pushPlatform: "all",
  });
  const appliedChannelParam = useRef<string | null>(null);
  useEffect(() => {
    const requested = typeof params.channel === "string" ? params.channel : "";
    if (requested === "push" && appliedChannelParam.current !== requested) {
      setPrefs({ channel: "push" });
    }
    appliedChannelParam.current = requested;
  }, [params.channel, setPrefs]);
  const channel: SuppressionChannel = prefs.channel === "push" ? "push" : "email";
  const pushPlatform = PUSH_PLATFORMS.includes(
    prefs.pushPlatform as (typeof PUSH_PLATFORMS)[number],
  )
    ? prefs.pushPlatform
    : "all";
  const filter = suppressionFilterByKey(prefs.reason);
  const setFilter = (next: SuppressionFilter) => {
    // LOVE#7. A reason bucket swaps the entire list underneath the chips.
    animateLayout("enter");
    setPrefs({ reason: next });
  };
  // The time window is a LOCAL VIEW over the loaded rows, exactly like
  // desktop's DateRangePopover (see lib/suppressionListRows.ts). Deliberately
  // NOT persisted across launches: "last 24 hours" is a triage lens for one
  // session, and reopening the screen silently pre-narrowed to it would read
  // as suppressions having vanished.
  const [windowPick, setWindowPick] = useState("all");
  const window = suppressionDateWindowByKey(windowPick);
  const setWindow = (next: SuppressionDateWindow) => {
    animateLayout("enter");
    setWindowPick(next);
  };
  const [addOpen, setAddOpen] = useState(false);
  const [mirrorOpen, setMirrorOpen] = useState(false);

  // Paged, not "the newest 50". The list read has always accepted `page=`;
  // nothing on this screen ever asked for a second one, so every suppression
  // older than the 50th was unreachable from a phone.
  const supp = useSuppressionList(debouncedQ);
  const trend = useSuppressionTrend(30);
  const refresh = useManualRefresh([supp.refetch, trend.refetch]);

  const mode = useAuthStore((s) => s.mode);
  const online = useIsOnline();
  const canWrite = canAccessMinimumRole("admin", gate.effectiveRole, mode);

  const page = supp.data?.value;
  const classified = classifySearchQuery(debouncedQ);

  // Newest-first over what's loaded, narrowed by whatever the server could
  // not narrow — the rule itself is pure, in lib/suppressionListRows.ts.
  const rows: SuppressionRow[] = useMemo(
    () => filterSuppressionRows(page?.items, filter, classified, window, now),
    [page, filter, classified, window, now],
  );

  const total = page?.total ?? 0;
  const scopeNote = suppressionScopeNoteWithWindow({
    shown: rows.length,
    total: page?.total,
    reasonFiltered: filter !== "all" || needsClientFilter(classified),
    windowFiltered: window !== "all",
    canLoadMore: supp.hasNextPage,
  });

  // Un-suppress (reversible → undo toast) and the CSV export, with the rule
  // that the export is NOT filtered even when the screen is.
  const rowActions = useSuppressionRowActions({
    filtered: Boolean(debouncedQ) || filter !== "all" || window !== "all",
    total,
  });
  const onUnsuppress = rowActions.onUnsuppress;

  // Multi-select: long-press a row to enter, tap to add/remove, Release from a
  // bar above the tab bar. Addressed by EMAIL because the converged list can
  // hold legacy rows whose ids do not exist in the X1 table — see
  // hooks/useSuppressionSelection.
  const loadedEmails = useMemo(
    () => rows.map((row) => (row.email ?? "").trim()).filter(Boolean),
    [rows],
  );
  const selection = useSuppressionSelection({
    loadedEmails,
    hasAdminRole: canWrite,
    online,
    gated: !gate.enabled,
  });

  const renderItem = useCallback(
    ({ item: row }: { item: SuppressionRow }) => (
      <SuppressionListRow
        row={row}
        now={now}
        t={t}
        canWrite={canWrite}
        selection={selection}
        onUnsuppress={onUnsuppress}
      />
    ),
    [canWrite, now, onUnsuppress, selection, t],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Suppressions"
        subtitle={
          channel === "email" && total > 0
            ? plural(total, "suppressed address")
            : undefined
        }
        onBack={goBackOrMore}
        right={
          <SuppressionHeaderActions
            channel={channel}
            canWrite={canWrite}
            rowCount={rows.length}
            total={total}
            online={gate.enabled}
            selecting={selection.active}
            exporting={rowActions.exporting}
            onSelect={selection.enter}
            onExport={rowActions.onExport}
            onAdd={() => setAddOpen(true)}
            onMirror={() => setMirrorOpen(true)}
          />
        }
      />
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 }}>
        <SuppressionChannelNav
          value={channel}
          onChange={(next) => setPrefs({ channel: next })}
        />
      </View>
      {channel === "push" ? (
        <PushSuppressionsPanel
          platform={pushPlatform}
          onPlatformChange={(next) => setPrefs({ pushPlatform: next })}
          now={now}
          t={t}
        />
      ) : (
      <>
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder="Search by email…"
          accessibilityLabel="Search suppressions by email"
          // This field searches ADDRESSES only, so the email keyboard is a
          // strict win here (it is not on Subscribers, which also searches
          // names and tags and needs the space bar).
          keyboardType="email-address"
          resultCount={rows.length}
          resultNoun="suppression"
        />
      </View>
      <View style={{ paddingBottom: 8 }}>
        <ChipRow
          options={SUPPRESSION_FILTERS.map((f) => ({
            value: f.key,
            label: f.label,
            accessibilityLabel: f.accessibilityLabel,
          }))}
          value={filter}
          onChange={setFilter}
          accessibilityLabel="Filter by suppression reason"
        />
      </View>
      <View style={{ paddingBottom: 8 }}>
        <ChipRow
          options={SUPPRESSION_DATE_WINDOWS.map((w) => ({
            value: w.key,
            label: w.label,
            accessibilityLabel: w.accessibilityLabel,
          }))}
          value={window}
          onChange={setWindow}
          accessibilityLabel="Filter by when the address was suppressed"
        />
      </View>
      <FlatList
        // Drag-to-dismiss: this screen has a search field, so the keyboard covers
        // roughly half the viewport and nothing else here closes it.
        keyboardDismissMode="on-drag"
        data={rows}
        keyExtractor={(row, index) => row.id || row.email || `row-${index}`}
        contentContainerStyle={{
          padding: 16,
          paddingTop: 4,
          paddingBottom: 32,
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
        {...MOBILE_LIST_PERF_PROPS}
        ListHeaderComponent={
          <>
            <CachedNotice backing={supp.data} now={now} />
            <SuppressionTrendHeader
              trend={trend.data}
              total={total}
              loading={trend.isLoading}
            />
          </>
        }
        ListEmptyComponent={
          <QueryStates
            query={supp}
            gate={gate}
            isEmpty
            skeleton={<SkeletonList rows={6} />}
            offlineMessage="You're offline and no suppression snapshot has been saved yet. It'll load when you reconnect."
            empty={{
              ...suppressionEmptyCopy(
                Boolean(debouncedQ) || filter !== "all" || window !== "all",
              ),
              ...(canWrite
                ? { cta: { label: "Suppress an address", onPress: () => setAddOpen(true) } }
                : {}),
            }}
          >
            {null}
          </QueryStates>
        }
        renderItem={renderItem}
        ListFooterComponent={
          // "Newest first" over what's LOADED is not "the newest record", and
          // when more pages exist the footer offers them — see the component.
          <SuppressionListFooter
            scopeNote={scopeNote}
            hasNextPage={supp.hasNextPage}
            isFetchingNextPage={supp.isFetchingNextPage}
            onLoadMore={() => void supp.fetchNextPage()}
            t={t}
          />
        }
      />
      </>
      )}
      {selection.active ? (
        <SuppressionSelectionBar
          count={selection.count}
          loadedCount={loadedEmails.length}
          allLoadedSelected={selection.allLoadedSelected}
          enabled={selection.availability.enabled}
          {...(selection.availability.reason
            ? { reason: selection.availability.reason }
            : {})}
          pending={selection.pending}
          onRelease={() => void selection.onRelease()}
          onSelectAll={selection.selectLoaded}
          onClear={selection.clear}
          onDone={selection.exit}
          t={t}
        />
      ) : null}
      <MirrorFromEspSheet
        visible={mirrorOpen}
        onClose={() => setMirrorOpen(false)}
      />
      <AddSuppressionSheet
        visible={addOpen}
        submitting={rowActions.adding}
        onClose={() => setAddOpen(false)}
        onSubmit={(input: { email: string; reason: ManualAddReason }) =>
          rowActions.onAdd(input, { onDone: () => setAddOpen(false) })
        }
      />
    </SafeAreaView>
  );
}
