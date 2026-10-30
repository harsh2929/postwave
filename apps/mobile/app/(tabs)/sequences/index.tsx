/**
 * Sequences list — entry point under the More menu.
 *
 * Mirrors the desktop's stored-sequence index. Rows show name, bounded status
 * truth, step count, and how long ago the row changed; pull-to-refresh
 * re-fetches the same TanStack query.
 *
 * TWO WAYS TO START A SEQUENCE HERE; THE BRANCHING CANVAS IS STILL NOT ONE OF
 * THEM, and that is a deliberate split rather than an unfinished one.
 *   - "New" names an empty draft. `POST /api/v1/voice/sequences` without a
 *     template_id is the cheap manual path that spends no LLM quota, and it is
 *     queued and replayed when offline.
 *   - "AI draft" describes a campaign to `POST /api/v1/voice/sequences/draft`
 *     and reviews what the model wrote before saving it — online only, because
 *     a metered generation cannot be replayed into a screen nobody is on. See
 *     components/sequences/SequenceDraftFlow.
 * Laying out a BRANCHING journey by hand on a phone is a different problem, and
 * `MOBILE_SEQUENCE_AUTHORING_AVAILABLE` keeps the canvas read-only until the
 * runtime and conflict-recovery contract are qualified — so the create sheet
 * SAYS steps are added on desktop or web instead of dropping the operator into
 * a canvas that refuses to be edited.
 *
 * There is no ACTIVATE verb on any surface, and mobile is not missing one: the
 * Voice handler refuses `active` on create AND on update with a 409 reading
 * "live sequence statuses are unavailable because the execution runtime is not
 * qualified" (services/voice/internal/handlers/sequences.go:709, :906).
 *
 * Three structural rules this screen now keeps:
 *   - ONE explanation per state. The "draft designer · live runtime
 *     unavailable" boundary used to render above the list in every state,
 *     including on top of "Sequences not available" (404) and the reconnect
 *     notice — two competing explanations for one empty screen is worse than
 *     either alone. It now renders only when there is a real journey list to
 *     qualify, mirroring how the detail screen nests its own boundary.
 *   - ONE loading affordance. RefreshControl was bound to `isFetching`, which
 *     is true during the initial fetch as well, so a cold load animated a
 *     spinner AND a list spinner at once. The cold path is a skeleton; the
 *     RefreshControl only reflects a user-initiated pull.
 *   - A CEILING. The endpoint takes no page/size params and returns every row
 *     for the tenant; see lib/sequenceListView.
 */
import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  type ListRenderItem,
  RefreshControl,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { sequenceStepCount, type SequenceListItem } from "@/api/sequences";
import { SequenceRow } from "@/components/sequences/SequenceRow";
import {
  CachedSessionNotice,
  cachedSessionNotice,
} from "@/components/CachedSessionNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StaleDataBanner } from "@/components/StaleDataBanner";
import { SearchField } from "@/components/SearchField";
import { SegmentedControl } from "@/components/SegmentedControl";
import {
  SequenceChromeBoundary,
  SequencesEmpty,
} from "@/components/sequences/SequenceChrome";
import { SequenceCreateSheet } from "@/components/sequences/SequenceCreateSheet";
import { SequenceListActions } from "@/components/sequences/SequenceDraftChrome";
import { SequenceDraftFlow } from "@/components/sequences/SequenceDraftFlow";
import { router } from "expo-router";

import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useCreateParam } from "@/hooks/useCreateParam";
import { useDebounced } from "@/hooks/useDebounced";
import { useListPreferences } from "@/hooks/useListPreferences";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { useSequenceList } from "@/hooks/useSequences";
import { canCreateSequence } from "@/lib/sequenceCreate";
import { canDraftSequenceWithAI } from "@/lib/sequenceDraft";
import {
  DEFAULT_SEQUENCE_LIST_PREFS,
  deriveSequenceListView,
  truncationNotice,
  type SequenceFilter,
  type SequenceSort,
} from "@/lib/sequenceListView";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useAuthStore } from "@/store/auth";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

const SORT_OPTIONS: readonly { value: SequenceSort; label: string }[] = [
  { value: "updated", label: "Recent" },
  { value: "name", label: "Name" },
  { value: "steps", label: "Steps" },
];

/**
 * A module constant, not an inline arrow. Declared inside the component this is
 * a NEW component type on every render, and React cannot reconcile two
 * different types — so every separator between every visible row was torn down
 * and rebuilt on each keystroke in the search field above.
 */
function SequenceSeparator() {
  return <View style={{ height: 8 }} />;
}

export default function SequencesIndex() {
  const { t } = useTheme();
  const onlineGate = useOnlineQueryGate();
  useScreenViewed("sequences");
  const sequenceGateNotice = cachedSessionNotice({
    gateEnabled: onlineGate.enabled,
    hasTenant: Boolean(onlineGate.tenantId),
    surface: "sequences",
  });
  // Identity-scoped and wiped on sign-out, so a filter never leaks between
  // workspaces on a shared device.
  const [prefs, setPrefs] = useListPreferences(
    "sequences",
    DEFAULT_SEQUENCE_LIST_PREFS,
  );
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  // `?new=1` — from the palette's "New sequence" and the shared onboarding
  // CTA (routeKey sequences.new) — opens the create sheet on arrival, the
  // same idiom as campaigns and forms. Written once in hooks/useCreateParam.
  useCreateParam(() => setCreateOpen(true));
  const [draftOpen, setDraftOpen] = useState(false);
  const debouncedQuery = useDebounced(query, 200);
  // Swipe-to-delete is offered only when it can succeed: DELETE is never
  // queued offline (lib/offlineQueueSafety) and needs write:campaigns.
  const mode = useAuthStore((s) => s.mode);
  // "A live session, right now" — the term that separates the writes that can
  // be queued and replayed from the ones that cannot. Hoisted because three
  // rules on this screen need it and each spelling it out cost a branch.
  const liveSession = onlineGate.enabled && !sequenceGateNotice;
  const canWriteRole = canAccessMinimumRole(
    "editor",
    onlineGate.effectiveRole,
    mode,
  );
  const canDeleteRows = liveSession && canWriteRole;

  // Cold-offline capable: with the gate closed this resolves the last saved
  // vault projection instead of rendering a reconnect notice over nothing.
  const seqs = useSequenceList();
  const refetchSequences = seqs.refetch;

  const result = seqs.data;
  // Array.isArray, not `?? []`. `deriveSequenceListView` iterates with for-of,
  // so a TRUTHY non-array is "items is not iterable" rather than an empty list
  // — and the nullish guard never saw it. The snapshot arm of useSequenceList
  // is the live route in: it wraps whatever the vault holds on a bare
  // truthiness check, over an unchecked `vaultGetJSON` cast.
  const allItems = useMemo(() => {
    const rows = result?.items;
    return Array.isArray(rows) ? rows : [];
  }, [result?.items]);
  const fromSnapshot = result?.fromSnapshot ?? false;
  const view = useMemo(
    () => deriveSequenceListView(allItems, prefs, debouncedQuery),
    [allItems, prefs, debouncedQuery],
  );
  const items = view.rows;
  const truncation = truncationNotice(view);
  const status = result?.error?.status ?? 0;
  const unavailable = status === 404 || status === 405 || status === 501;
  // `seqs.error` is now also raised when the gate is closed AND no projection
  // has ever been stored (OfflineSnapshotUnavailableError). The cached-session
  // notice below is still the explanation shown in that case; a raw error is
  // only rendered once a live session has genuinely failed.
  const loadFailed = Boolean(seqs.error || result?.error);
  // Why creating uses a different rule from deleting: see canCreateSequence.
  const canCreate = canCreateSequence({
    hasTenant: Boolean(onlineGate.tenantId),
    unavailable,
    canWrite: canWriteRole,
  });
  // AI drafting adds an `online` term the blank create deliberately lacks —
  // see canDraftSequenceWithAI for why the two rules differ.
  const canDraft = canDraftSequenceWithAI({
    hasTenant: Boolean(onlineGate.tenantId),
    unavailable,
    canWrite: canWriteRole,
    online: liveSession,
  });
  const openCreate = useCallback(() => setCreateOpen(true), []);
  const openDraft = useCallback(() => setDraftOpen(true), []);
  const closeDraft = useCallback(() => setDraftOpen(false), []);
  const openCreatedSequence = useCallback(
    (newId: string) =>
      router.push({
        pathname: "/(tabs)/sequences/[id]",
        params: { id: newId },
      }),
    [],
  );
  // Only offer the controls once there is data and the endpoint is up.
  const showControls = !seqs.isLoading && !unavailable && view.total > 0;
  // ONE explanation per state: qualify the list only when there IS a list.
  const showBoundary =
    !unavailable && !sequenceGateNotice && !loadFailed && !seqs.isLoading;

  const keyExtractor = useCallback(
    (s: SequenceListItem, idx: number) => String(s.id ?? idx),
    [],
  );
  const onRefresh = useCallback(() => {
    if (sequenceGateNotice) return;
    haptics.tap();
    void refetchSequences();
  }, [refetchSequences, sequenceGateNotice]);
  const onFilter = useCallback(
    (next: SequenceFilter) => {
      haptics.tap();
      setPrefs({ filter: next });
    },
    [setPrefs],
  );
  const onSort = useCallback(
    (next: SequenceSort) => {
      haptics.tap();
      setPrefs({ sort: next });
    },
    [setPrefs],
  );

  const renderSequence = useCallback<ListRenderItem<SequenceListItem>>(
    ({ item }) => (
      <SequenceRow
        item={item}
        stepCount={sequenceStepCount(item)}
        canDelete={canDeleteRows}
      />
    ),
    [canDeleteRows],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Sequences"
        subtitle={
          showControls && !seqs.isFetching
            ? `Loaded ${relativeTime(seqs.dataUpdatedAt)}`
            : undefined
        }
        onBack={goBackOrMore}
        // Two verbs, two costs, so two controls: "New" is free and works
        // offline, "AI draft" spends a metered request and does not.
        right={
          <SequenceListActions
            canCreate={canCreate}
            canDraft={canDraft}
            onCreate={openCreate}
            onDraft={openDraft}
          />
        }
      />
      {showControls ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 4, gap: 8 }}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder="Search sequences"
            accessibilityLabel="Search sequences by name or status"
            resultCount={query.trim() ? view.matched : undefined}
            resultNoun="sequence"
          />
          <SegmentedControl<SequenceFilter>
            options={[
              { value: "all", label: "All", badge: view.total },
              { value: "drafts", label: "Drafts", badge: view.draftCount },
              {
                value: "read_only",
                label: "Read-only",
                badge: view.readOnlyCount,
              },
            ]}
            value={prefs.filter}
            onChange={onFilter}
            accessibilityLabel="Filter sequences"
            scrollable
          />
          <SegmentedControl<SequenceSort>
            options={SORT_OPTIONS}
            value={prefs.sort}
            onChange={onSort}
            accessibilityLabel="Sort order"
          />
        </View>
      ) : null}
      {showBoundary ? <SequenceChromeBoundary /> : null}
      <FlatList
        // Drag-to-dismiss: this screen has a search field, so the keyboard covers
        // roughly half the viewport and nothing else here closes it.
        keyboardDismissMode="on-drag"
        {...MOBILE_LIST_PERF_PROPS}
        data={items}
        keyExtractor={keyExtractor}
        contentContainerStyle={{ padding: 16, paddingTop: 8 }}
        ItemSeparatorComponent={SequenceSeparator}
        refreshControl={
          <RefreshControl
            // `isFetching && !isLoading` — a cold load shows the skeleton
            // instead, so exactly one affordance animates at a time.
            refreshing={seqs.isFetching && !seqs.isLoading}
            onRefresh={onRefresh}
            enabled={!sequenceGateNotice}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          <SequenceListHeader
            notice={sequenceGateNotice}
            fromSnapshot={fromSnapshot}
            hasRows={view.total > 0}
            onRetry={onRefresh}
          />
        }
        ListFooterComponent={
          truncation ? (
            <Text
              accessibilityRole="alert"
              {...typeCap("label")}
              style={{
                color: t.fgMuted,
                ...typeStyle("label"),
                textAlign: "center",
                paddingVertical: 16,
                fontFamily: FONT.regular,
              }}
            >
              {truncation}
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <SequencesEmpty
            loading={seqs.isLoading}
            notice={sequenceGateNotice}
            unavailable={unavailable}
            failureMessage={listFailureMessage(
              loadFailed,
              result?.error?.message,
              seqs.error,
            )}
            onRetry={() => void refetchSequences()}
            onCreate={canCreate ? openCreate : undefined}
            onDraft={canDraft ? openDraft : undefined}
            total={view.total}
            query={debouncedQuery.trim()}
            filter={prefs.filter}
          />
        }
        renderItem={renderSequence}
      />
      <SequenceCreateSheet
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        // Straight into the new draft: the whole point of naming it here is
        // to see it exist. Only ever reached with a server-confirmed id — a
        // queued create has none, and the sheet does not call this.
        onCreated={openCreatedSequence}
      />
      {/* Brief → model → review → saved draft. Mounted unconditionally so the
          review sheet survives a re-render mid-review; `visible` is the gate,
          and the flow resets itself whenever it closes. */}
      <SequenceDraftFlow
        visible={draftOpen}
        onClose={closeDraft}
        onCreated={openCreatedSequence}
      />
    </SafeAreaView>
  );
}

/**
 * The most specific sentence a failed list read can justify, or null.
 *
 * Two provenances, in priority order: a product answer the payload carried
 * (`result.error.message` — a 4xx the query resolved rather than threw), then a
 * thrown query (the network died before the request resolved). The generic
 * fallback is last precisely because it says nothing.
 */
function listFailureMessage(
  failed: boolean,
  payloadMessage: string | undefined,
  thrown: unknown,
): string | null {
  if (!failed) return null;
  if (payloadMessage) return payloadMessage;
  return thrown instanceof Error ? thrown.message : "Pull down to retry.";
}

/**
 * What the rows ARE, when they are not simply live.
 *
 * Two different provenances, two different sentences: the online gate being
 * closed is a session state the CachedSessionNotice already explains, while a
 * live session that fell back to the stored projection mid-request has no gate
 * notice at all and would otherwise present a saved copy as fresh.
 */
function SequenceListHeader({
  notice,
  fromSnapshot,
  hasRows,
  onRetry,
}: {
  notice: ReturnType<typeof cachedSessionNotice>;
  fromSnapshot: boolean;
  hasRows: boolean;
  onRetry: () => void;
}) {
  if (!hasRows) return null;
  if (notice) {
    return (
      <CachedSessionNotice
        notice={notice}
        variant="stale"
        style={{ marginBottom: 8 }}
      />
    );
  }
  if (fromSnapshot) {
    return (
      <StaleDataBanner
        message="Showing the saved copy of your sequences."
        onRetry={onRetry}
      />
    );
  }
  return null;
}
