/**
 * Approvals tab — the on-the-go approver's queue.
 *
 * UX shape:
 *   - A four-tile summary (pending / approved 7d / rejected 7d / average
 *     time-to-decide) so the screen answers "is this queue healthy?", not
 *     only "how long is it?".
 *   - Search + Pending/All chips. Pending is the default: it is the
 *     actionable subset.
 *   - Rows: tap opens the request; swipe left approves or rejects for
 *     clearing a queue at speed. Swipe-approve skips the pre-confirm (the
 *     gesture is deliberate) and pairs with a toast, per SwipeableRow's
 *     documented contract; the tap path keeps a ConfirmSheet.
 *
 * ROLE NOTE: GET /api/v1/approvals is owner/admin-only (requireAdmin in
 * approvals/handlers.go). Editors and viewers previously got a permanently
 * erroring primary tab plus a 403 every 60 seconds; now they get a scope
 * notice and no request at all. Hiding the TAB itself needs the manifest +
 * tab layout, which this screen does not own — see the orchestrator note.
 *
 * FOCUS NOTE: Expo Router keeps a visited tab MOUNTED, so the 60s pending poll
 * and the 1s expiry clock both take `canDecide && focused`. The poll shares its
 * cache key with the tab badge (5 min, useApprovals.ts); the shortest mounted
 * observer wins, so one visit used to hold the badge key at 60s for the whole
 * session and re-render this hidden tree every second. Gating `enabled` (not
 * just the interval) also refetches a stale queue the moment the tab refocuses,
 * and useTickingNow ticks immediately when `active` turns true again.
 */
import { useCallback, useMemo, useState } from "react";
import { router, useIsFocused } from "expo-router";
import { FlatList, type ListRenderItem, RefreshControl, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SkeletonList } from "@/components/Skeleton";
import { StaleDataBanner } from "@/components/StaleDataBanner";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { ApprovalFreshnessLine } from "@/components/approvals/ApprovalFreshnessLine";
import { ApprovalHistoryControls } from "@/components/approvals/ApprovalHistoryControls";
import { ApprovalRow } from "@/components/approvals/ApprovalRow";
import { FlowReviewsLink } from "@/components/approvals/FlowReviewsLink";
import { ApprovalSummary } from "@/components/approvals/ApprovalSummary";
import { NewApprovalsPill } from "@/components/approvals/NewApprovalsPill";
import { approvalCountLine } from "@/components/approvals/approvalCounts";
import { RejectReasonModal } from "@/components/approvals/RejectReasonModal";
import {
  approvalDecisionStats,
  approvalEmptyCopy,
  approvalGateNotice,
  approvalTruncationNotice,
  canRefreshApprovals,
  type FilterKey,
} from "@/components/approvals/approvalPresentation";
import {
  applyApprovalHistoryView,
  type ApprovalSortKey,
  type ApprovalStatusFilter,
} from "@/components/approvals/approvalHistoryView";
import { filterApprovals } from "@/components/approvals/approvalSearch";
import {
  APPROVALS_PAGE_LIMIT,
  escalationHint,
  useAllApprovals,
  useApprovalEscalationPolicy,
  usePendingApprovals,
  type Approval,
} from "@/hooks/useApprovals";
import { useApprovalArrivals } from "@/hooks/useApprovalArrivals";
import { useApprovalDecisions } from "@/hooks/useApprovalDecisions";
import { PENDING_APPROVAL_STATUS, useFlowApprovals } from "@/hooks/useFlows";
import { useDebounced } from "@/hooks/useDebounced";
import { freshnessSentence } from "@/lib/auditGrouping";
import { isDecidable } from "@/lib/flowApprovals";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useTickingNow } from "@/hooks/useTickingNow";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { useAuthStore } from "@/store/auth";

/**
 * Expo Router picks this up per route file: a malformed approval payload
 * now degrades this screen instead of white-screening the whole app via the
 * root boundary.
 */
export { AppErrorBoundary as ErrorBoundary };

export default function Approvals() {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [filter, setFilter] = useState<FilterKey>("pending");
  // Desktop's history status/sort selects, as chips (approvalHistoryView.ts).
  const [historyStatus, setHistoryStatus] =
    useState<ApprovalStatusFilter>("all");
  const [sort, setSort] = useState<ApprovalSortKey>("newest");
  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q, 200);
  const onlineGate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const canDecide = canAccessMinimumRole("admin", onlineGate.effectiveRole, mode);
  const focused = useIsFocused();

  // The OTHER human gate. Deliberately fetched regardless of `canDecide`:
  // GET /api/v1/flow-builder/approvals only needs read:campaigns, so the
  // editor who is bounced off this screen by requireAdmin is exactly the
  // person who can act on these — see FlowReviewsLink for why they are a
  // link and not merged rows.
  const flowReviews = useFlowApprovals(PENDING_APPROVAL_STATUS);
  const flowReviewCount = flowReviews.data
    ? flowReviews.data.filter(isDecidable).length
    : null;

  const disabledNotice = approvalGateNotice({
    gateEnabled: onlineGate.enabled,
    hasTenant: Boolean(onlineGate.tenantId),
  });

  // A 1s clock so "Expires in 3m" is actually a countdown and a row
  // disables itself the moment it crosses its expiry, instead of staying
  // tappable through a confirm chain that can only end in a 410.
  const now = useTickingNow(canDecide && focused);

  const pending = usePendingApprovals(canDecide && focused);
  // The "All" set is fetched whenever the screen is open, not only when its
  // chip is active: the 7-day decision counters are derived from decided
  // rows, and the pending query by definition has none. One extra capped
  // request per visit beats four tiles that read a confident, false zero.
  const all = useAllApprovals(canDecide);
  const active = filter === "pending" ? pending : all;
  const escalation = useApprovalEscalationPolicy();
  const {
    isDeciding,
    decidingId,
    rejectDraft,
    setRejectDraft,
    rejectError,
    setRejectError,
    confirmApprove,
    openReject,
    submitReject,
    rejectFocusTarget,
  } = useApprovalDecisions({
    rows: Array.isArray(active.data) ? active.data : [],
    confirm,
    toast,
  });

  const refresh = useManualRefresh([active.refetch], {
    enabled: canRefreshApprovals(disabledNotice),
  });

  const openDetail = useCallback((approval: Approval) => {
    router.push({
      pathname: "/(tabs)/approvals/[id]",
      params: { id: approval.id },
    });
  }, []);

  const keyExtractor = useCallback((a: Approval) => a.id, []);
  /**
   * Hoisted out of the row. `ApprovalRow` is `React.memo`'d and `onApprove`
   * was an arrow rebuilt inside `renderItem`, so the memo could never hold —
   * every visible request re-rendered whenever this screen re-rendered, which
   * on a 60s-polled queue with a decision in flight is often.
   */
  const onApprove = useCallback(
    (row: Approval, label: string, rowRef: { current: unknown }) => {
      void confirmApprove(row, label, rowRef);
    },
    [confirmApprove],
  );
  const renderApproval = useCallback<ListRenderItem<Approval>>(
    ({ item: a }) => (
      <ApprovalRow
        approval={a}
        decidingId={decidingId}
        anyDeciding={isDeciding}
        gateNotice={disabledNotice}
        now={now}
        currentUserId={onlineGate.userId}
        onOpen={openDetail}
        onApprove={onApprove}
        onReject={openReject}
      />
    ),
    [
      decidingId,
      disabledNotice,
      isDeciding,
      now,
      onApprove,
      onlineGate.userId,
      openDetail,
      openReject,
    ],
  );

  // GOVERNANCE#29 — the queue polls every 60s (useApprovals.ts:135) and is
  // newest-first, so an arriving request used to PREPEND itself and slide the
  // row under the reader's thumb down one position. On the one screen where a
  // mis-tap is unrecoverable — and where swipe-approve deliberately skips the
  // confirm — that is a defect, not a nicety. Arrivals are now COUNTED, not
  // inserted, exactly as the audit log's tail does it.
  const arrivals = useApprovalArrivals(active.data, filter);

  const rows = arrivals.rows;
  const historyRows = all.data;
  // Deliberately the RAW page, never the held subset: the summary answers "is
  // this queue healthy?", which is a question about the queue, not about what
  // is currently rendered. A held arrival is still pending work.
  const stats = useMemo(
    () => approvalDecisionStats(historyRows ?? active.data ?? rows, now),
    [active.data, historyRows, now, rows],
  );

  // Pipeline: search → status slice → sort. The status slice applies only to
  // the All window (Pending IS a status filter); the sort applies to both.
  const filtered: Approval[] = useMemo(
    () =>
      applyApprovalHistoryView(
        filterApprovals(rows, debouncedQ),
        { status: historyStatus, sort },
        filter === "pending",
      ),
    [rows, debouncedQ, historyStatus, sort, filter],
  );

  const emptyCopy = approvalEmptyCopy({
    filter,
    query: debouncedQ,
    gateNotice: disabledNotice,
  });
  const hasRows = filtered.length > 0;
  const firstLoad = active.isLoading && rows.length === 0;

  if (!canDecide) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <ScreenHeader title="Approvals" />
        <View style={{ padding: 16 }}>
          <MobileScopeNotice
            title="Approvals need an admin role"
            body="Deciding approval requests is limited to workspace owners and admins. Ask an admin for access, or switch to a workspace where you hold one."
          />
          {/* Not a dead end: in-flow manual reviews are a DIFFERENT endpoint
              with a weaker gate, and an editor bounced off this screen may
              well have work waiting there. */}
          <View style={{ marginTop: 12 }}>
            <FlowReviewsLink count={flowReviewCount} />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader title="Approvals" onSearch />
      <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 }}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder="Search resource, requester, or status…"
          accessibilityLabel="Search resource, requester, or status"
          {...(debouncedQ.trim() ? { resultCount: filtered.length } : {})}
          resultNoun="approval"
        />
        {/* Window + status + sort chips, animated via lib/motion inside the
            component so the queue never re-composes in one frame. */}
        <ApprovalHistoryControls
          filter={filter}
          onFilterChange={setFilter}
          status={historyStatus}
          onStatusChange={setHistoryStatus}
          sort={sort}
          onSortChange={setSort}
        />
      </View>
      <FlatList
        ref={arrivals.listRef}
        {...MOBILE_LIST_PERF_PROPS}
        data={filtered}
        keyExtractor={keyExtractor}
        renderItem={renderApproval}
        keyboardShouldPersistTaps="handled"
        // The search field sits directly above: without this the keyboard
        // covers half the queue and the only way past it is to leave.
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ padding: 16, paddingTop: 4, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            // A deliberate pull IS the ask — holding arrivals behind a pill
            // after the reader explicitly requested fresh rows would be the
            // app second-guessing an instruction it was just given.
            onRefresh={() => {
              arrivals.adopt();
              refresh.onRefresh();
            }}
            enabled={!disabledNotice}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          firstLoad ? (
            <SkeletonList rows={5} />
          ) : (
            <View style={{ gap: 8, marginBottom: 8 }}>
              {/* First in the stack, exactly as AuditTailBanner is on the
                  audit log: the reader must meet "the list is holding
                  something back" before any figure derived from it. */}
              <NewApprovalsPill
                count={arrivals.newCount}
                onLoad={arrivals.adopt}
              />
              {disabledNotice && hasRows ? (
                <StaleDataBanner message={disabledNotice.staleMessage} />
              ) : null}
              {active.isError && hasRows ? (
                <ErrorState
                  compact
                  message="Couldn't refresh — showing the last results."
                  onRetry={() => void active.refetch()}
                />
              ) : null}
              <FlowReviewsLink count={flowReviewCount} />
              {!disabledNotice && !active.isError ? (
                <ApprovalSummary
                  stats={stats}
                  decisionsKnown={historyRows !== undefined}
                  countLine={approvalCountLine({
                    filter,
                    shown: filtered.length,
                    loaded: rows.length,
                    searching: Boolean(debouncedQ.trim()),
                  })}
                  truncationNotice={approvalTruncationNotice(
                    (historyRows ?? rows).length,
                    APPROVALS_PAGE_LIMIT,
                  )}
                  escalationNotice={escalationHint(escalation.data)}
                />
              ) : null}
              <ApprovalFreshnessLine
                sentence={freshnessSentence("Queue", active.dataUpdatedAt, now)}
              />
            </View>
          )
        }
        ListEmptyComponent={
          firstLoad ? null : active.isError ? (
            <ErrorState
              error={active.error}
              onRetry={() => void active.refetch()}
            />
          ) : (
            <EmptyState
              title={emptyCopy.title}
              description={emptyCopy.description}
            />
          )
        }
      />
      <RejectReasonModal
        visible={Boolean(rejectDraft)}
        label={rejectDraft?.label ?? ""}
        reason={rejectDraft?.reason ?? ""}
        busy={isDeciding}
        error={rejectError}
        restoreFocusTo={rejectFocusTarget}
        onChangeReason={(reason) => {
          setRejectError(null);
          setRejectDraft((cur) => (cur ? { ...cur, reason } : cur));
        }}
        onCancel={() => {
          setRejectDraft(null);
          setRejectError(null);
        }}
        onSubmit={submitReject}
      />
    </SafeAreaView>
  );
}
