/**
 * Discounts — the code list and who redeemed each code.
 *
 * WHAT THIS SCREEN CAN ACTUALLY DO. The API's discount surface is a fail-closed
 * boundary that NARROWED, briefly re-opened, and narrowed again. `MountRoutes`
 * (apps/api/internal/discounts/handlers.go) registers two reads: the sanitized
 * archive and its PII-free event timeline. The A1 release (2026-08-18) mounted
 * four more — `/check`, PATCH, `redemptions.csv`, DELETE — and that was
 * reversed, because the deployment composes `discounts.Deps` with no Stripe
 * bridge (a DELETE that can never complete) and the archive stopped serializing
 * redeemable codes at all (nothing to put in a `{code}` path). Every affordance
 * here is gated on `lib/discountMutationBoundary`, whose guard test parses the
 * Go mount list in both directions, so a route that goes away takes its button
 * with it and a route that arrives fails the build until someone builds for it.
 *
 * So the questions this screen answers are:
 *
 *   1. "What codes exist and what shape are they in?" The pill on each row is
 *      DERIVED from the list payload's `expires_at`/`max_redemptions`, which
 *      may be a twelve-hour-old offline snapshot. There is no server verdict to
 *      pair it with, so the drawer SAYS that rather than letting the pill read
 *      as confirmed.
 *   2. "Who used it?" The drawer lists the newest events and grows a page at a
 *      time. It is addressed by record ID and it names no subscriber: the
 *      archive returns a linkage bit, not an identity.
 *   3. "This code leaked — stop it." Moosewave cannot, on this deployment. That
 *      is the one absence stated in words instead of an omitted button, because
 *      an operator who came here at 2am for exactly this has to be told no —
 *      see DISCOUNT_KILL_SWITCH_UNAVAILABLE_NOTICE.
 *
 * The state lives in `useDiscountsScreen`; this file is the layout.
 */
import { useCallback, useMemo } from "react";
import {
  FlatList,
  type ListRenderItem,
  RefreshControl,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { EmptyState } from "@/components/EmptyState";
import { QueryStates } from "@/components/QueryStates";
import { CachedNotice } from "@/components/deliverability/CachedNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { DiscountCard } from "@/components/discounts/DiscountCard";
import { DiscountEditSheet } from "@/components/discounts/DiscountEditSheet";
import { DiscountsFilterBar } from "@/components/discounts/DiscountsFilterBar";
import type { DiscountDrawerBinding } from "@/components/discounts/DiscountRedemptionsDrawer";
import { shareSlotWidth } from "@/components/discounts/discountStatus";
import { OfflineNotice } from "@/components/discounts/OfflineNotice";
import { isProbablyOnline } from "@/lib/connectivity";
import type { DiscountRow } from "@/hooks/useDiscountOps";
import { useDiscountsScreen } from "@/hooks/useDiscountsScreen";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";

// Route-scoped boundary: a render crash in one discount row must fail THIS
// screen, not blank the whole app back to the root boundary.
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

/**
 * The props for a COLLAPSED card. Module-level and frozen so every unexpanded
 * row gets the same object identity: the queries behind them return fresh
 * result objects on each render, and handing those to all 200 cards would
 * defeat `DiscountCard`'s memo and re-render the whole list every time the one
 * open drawer polled.
 */
const IDLE_REDEMPTIONS = Object.freeze({
  isFetching: false,
  isError: false,
  error: null,
  data: undefined,
  refetch: () => undefined,
});

const IDLE_BINDING: DiscountDrawerBinding = Object.freeze({
  check: Object.freeze({
    isFetching: false,
    isError: false,
    error: null,
    data: undefined,
  }),
  canLoadMore: false,
  loadingMore: false,
  onLoadMore: () => undefined,
  exporting: false,
  onExport: null,
  onEdit: null,
  onDelete: null,
  deleting: false,
});

export default function Discounts() {
  const offlineGate = useOnlineQueryGate();
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const shareSlot = shareSlotWidth(fontScale);
  const { toast } = useToast();
  const s = useDiscountsScreen(toast);
  useScreenViewed("discounts");

  // Only a real pull spins the control. `isRefetching` also fires for the
  // refetch that a foreground resume triggers (connectivity.ts bridges AppState
  // into TanStack's focusManager), which made the spinner appear spontaneously
  // under a reader who had not touched the screen.
  const refresh = useManualRefresh([s.discounts.refetch], {
    enabled: s.gate.enabled,
  });

  // The binding is rebuilt whenever the open drawer's state changes, which is
  // correct — it is handed ONLY to the expanded row. Memoised because
  // `renderRow` below depends on it: an object rebuilt on every render would
  // reintroduce, one level up, exactly the per-render `renderItem` identity
  // that hoisting is meant to remove.
  const binding: DiscountDrawerBinding = useMemo(
    () => ({
      check: s.check,
      canLoadMore: s.canLoadMore,
      loadingMore: s.loadingMore,
      onLoadMore: s.onLoadMore,
      exporting: s.exporting,
      onExport: s.onExport,
      onEdit: s.onEdit,
      onDelete: s.onDelete,
      deleting: s.deleting,
    }),
    [
      s.canLoadMore,
      s.check,
      s.deleting,
      s.exporting,
      s.loadingMore,
      s.onDelete,
      s.onEdit,
      s.onExport,
      s.onLoadMore,
    ],
  );

  // Offline with nothing to show must not read as an empty success. The fetch
  // either failed, or was never allowed to run — on a cold offline launch the
  // online-query gate keeps the query disabled until the session revalidates,
  // so it never errors. Either way, while offline with no data we cannot tell
  // an empty account from missing data.
  const offline =
    !isProbablyOnline() && !s.discounts.isLoading && s.all.length === 0;

  // Hoisted: an inline `renderItem` is a new function on every render, which
  // VirtualizedList reads as "the row renderer changed" and re-renders every
  // mounted cell — undoing DiscountCard's own `memo`. Typing a search term
  // re-rendered all 200 rows per keystroke for that reason alone.
  const keyExtractor = useCallback(
    (row: DiscountRow, index: number) => row.id || row.code || `row-${index}`,
    [],
  );
  const renderRow = useCallback<ListRenderItem<DiscountRow>>(
    ({ item: row }) => {
      const expanded = s.expandedRecordId === row.id;
      return (
        <DiscountCard
          row={row}
          expanded={expanded}
          onToggle={s.onToggle}
          onShare={s.onShare}
          redemptions={expanded ? s.redemptions : IDLE_REDEMPTIONS}
          binding={expanded ? binding : IDLE_BINDING}
          shareSlot={shareSlot}
          fontScale={fontScale}
          now={s.now}
        />
      );
    },
    [
      binding,
      fontScale,
      s.expandedRecordId,
      s.now,
      s.onShare,
      s.onToggle,
      s.redemptions,
      shareSlot,
    ],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader title="Discounts" onBack={goBackOrMore} />
      <DiscountsFilterBar
        q={s.q}
        onChangeQ={s.setQ}
        resultCount={s.debouncedQ.trim() ? s.rows.length : undefined}
        filter={s.filter}
        onChangeFilter={s.setFilter}
        summary={s.summary}
        visibleCount={s.rows.length}
        hasFilter={s.hasFilter}
      />
      {/* perf: render the (potentially long) code list with a virtualized
          FlatList instead of mapping every row inside a ScrollView. The offline
          banner moves to ListHeaderComponent and the loading/error/empty
          branches to ListEmptyComponent so all states are preserved. */}
      <FlatList
        data={s.rows}
        keyExtractor={keyExtractor}
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
            enabled={s.gate.enabled}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        {...MOBILE_LIST_PERF_PROPS}
        ListHeaderComponent={
          offline ? (
            <OfflineNotice />
          ) : (
            // Snapshot provenance, in the SAME component the deliverability
            // screens use — a cached catalogue must say it is cached, and how
            // old it is, or an operator reads a withdrawn code as live.
            <CachedNotice backing={s.discounts.data} />
          )
        }
        ListEmptyComponent={
          // Offline keeps its own banner in ListHeaderComponent, so nothing
          // renders under it. Everything else goes through the shared ladder
          // (error before empty, skeleton on first load only); `isEmpty` is the
          // UNFILTERED count, so the child owns the filtered-out case.
          offline ? null : (
            <QueryStates
              query={s.discounts}
              isEmpty={s.all.length === 0}
              skeleton={<SkeletonList rows={6} />}
              gate={offlineGate}
            offlineMessage={"Discount codes need a connection. Nothing has been loaded on this device yet."}
            empty={{
                title: "No discount codes",
                description: "Create discount codes from the web admin.",
              }}
            >
              <EmptyState
                title="Nothing matches"
                description="Try widening the filters."
              />
            </QueryStates>
          )
        }
        renderItem={renderRow}
      />
      {/* A page sheet, so it renders over the list rather than inside it; it is
          a no-op until a row is chosen (`row === null` keeps the Modal
          invisible), which is why it can sit unconditionally in the tree. */}
      <DiscountEditSheet row={s.editRow} onClose={s.closeEdit} />
    </SafeAreaView>
  );
}
