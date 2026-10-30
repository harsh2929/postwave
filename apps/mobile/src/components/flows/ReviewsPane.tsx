/**
 * ReviewsPane — the parked `manual_review` queue.
 *
 * Split out of app/(tabs)/flows.tsx alongside FlowsPane; the row itself, and
 * every rule about which rows may be decided, lives in
 * components/flows/FlowApprovalRow and lib/flowApprovals.
 *
 * THE EMPTY STATE IS THE INTERESTING PART. "Nothing waiting" is almost always
 * true here, and the honest reason is not that the team is on top of its
 * queue: the flow runtime is contained, so nothing is executing to park at a
 * review gate in the first place. Saying that plainly stops an operator
 * concluding their reviews were silently dropped.
 *
 * NativeWind v4 gotcha: static style objects only.
 */
import { FlatList, RefreshControl } from "react-native";

import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SkeletonList } from "@/components/Skeleton";
import { FlowApprovalRow } from "@/components/flows/FlowApprovalRow";
import type {
  FlowApprovalDecision,
  MobileFlowApproval,
} from "@/lib/flowApprovals";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { useTheme } from "@/lib/theme";

import type { RefreshLike } from "@/components/flows/FlowsPane";

export function ReviewsPane({
  approvals,
  rows,
  gate,
  refresh,
  now,
  canDecide,
  online,
  pendingId,
  onDecide,
}: {
  approvals: QueryLike & { data: readonly MobileFlowApproval[] | undefined };
  rows: readonly MobileFlowApproval[];
  gate: { enabled: boolean };
  refresh: RefreshLike;
  now: number;
  canDecide: boolean;
  online: boolean;
  pendingId: string | null;
  onDecide: (
    approval: MobileFlowApproval,
    decision: FlowApprovalDecision,
  ) => void;
}) {
  const { t } = useTheme();
  return (
    <FlatList
      data={approvals.data === undefined ? [] : rows}
      keyExtractor={(approval) => approval.id}
      contentContainerStyle={{
        padding: 16,
        paddingTop: 12,
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
      ListEmptyComponent={
        <QueryStates
          query={approvals}
          gate={gate}
          isEmpty={rows.length === 0}
          offlineMessage="You're offline, so the review queue can't be loaded — and a decision wouldn't reach the server."
          skeleton={<SkeletonList rows={3} />}
          empty={{
            title: "Nothing waiting",
            // The honest reason, not a cheerful one: with the runtime
            // contained, nothing is executing to park at a review gate.
            description:
              "No flow is parked at a manual-review step. Reviews appear here when a running flow reaches one — and the flow runtime is currently unavailable, so none will until it is enabled.",
          }}
        >
          {null}
        </QueryStates>
      }
      renderItem={({ item }) => (
        <FlowApprovalRow
          approval={item}
          now={now}
          canDecide={canDecide}
          online={online}
          busy={pendingId === item.id}
          onDecide={onDecide}
        />
      )}
    />
  );
}
