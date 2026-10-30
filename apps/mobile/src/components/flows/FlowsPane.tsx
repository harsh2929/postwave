/**
 * FlowsPane — the catalogue list, with the five-state ladder around it.
 *
 * Split out of app/(tabs)/flows.tsx so the route file stays orchestration:
 * which pane is showing, what the queries are, and what a decision does. The
 * two panes are genuinely independent lists that happen to share a header.
 *
 * TWO CLAIMS HERE ARE LOAD-BEARING
 *  1. The header states, once, that nothing is executing — rather than
 *     repeating the caveat on every row. `flowStatusPresentation` still makes
 *     each row's pill honest on its own.
 *  2. "There is more" comes from the server's `nextCursor` and nothing else.
 *     Comparing a row count against a guessed page size breaks silently the
 *     moment `ListFlows`' default moves, and the failure mode is a truncated
 *     list that looks complete.
 *
 * NativeWind v4 gotcha: static style objects only.
 */
import { FlatList, RefreshControl, Text } from "react-native";

import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SkeletonList } from "@/components/Skeleton";
import { FlowRow } from "@/components/flows/FlowRow";
import { FONT } from "@/lib/fonts";
import type { FlowLabels } from "@/lib/flowCatalog";
import type { FlowPage, MobileFlow } from "@/lib/flowWire";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface RefreshLike {
  refreshing: boolean;
  onRefresh: () => void;
}

export function FlowsPane({
  flows,
  rows,
  hasMore,
  gate,
  refresh,
  now,
  searching,
  labels,
  onOpen,
}: {
  /** The real query, narrowed to the ladder's contract plus its payload. */
  flows: QueryLike & { data: FlowPage | undefined };
  rows: readonly MobileFlow[];
  hasMore: boolean;
  gate: { enabled: boolean };
  refresh: RefreshLike;
  now: number;
  searching: boolean;
  /** Server catalogue labels, resolved once by the route. */
  labels: FlowLabels;
  onOpen: (flow: MobileFlow) => void;
}) {
  const { t } = useTheme();
  return (
    <FlatList
      data={flows.data === undefined ? [] : rows}
      keyExtractor={(flow) => flow.id}
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
      ListHeaderComponent={
        rows.length > 0 ? (
          <MobileScopeNotice
            title="Read-only, and nothing is running"
            body="Flows are designed in the desktop builder. The flow runtime is unavailable, so a flow labelled active is a stored label — no subscriber is moving through it."
          />
        ) : null
      }
      ListFooterComponent={
        // `nextCursor` is the server saying "there is more", which is the only
        // honest source for this claim — comparing a row count to a guessed
        // page size breaks the moment the default moves.
        hasMore ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              marginTop: 8,
            }}
          >
            Showing the most recently edited flows. This workspace has more than
            fit on one page — open the desktop builder to see the rest.
          </Text>
        ) : null
      }
      ListEmptyComponent={
        <QueryStates
          query={flows}
          gate={gate}
          isEmpty={rows.length === 0}
          offlineMessage="You're offline, so your flows can't be loaded. Reconnect and pull to refresh."
          skeleton={<SkeletonList rows={4} />}
          empty={
            searching
              ? {
                  title: "No match",
                  description:
                    "No flow's name contains that. Clear the search to see them all.",
                }
              : {
                  title: "No flows yet",
                  description:
                    "A flow is an automation — a trigger, then steps a subscriber moves through. They are built in the desktop flow builder; once one exists, its steps and versions show up here.",
                }
          }
        >
          {null}
        </QueryStates>
      }
      renderItem={({ item }) => (
        <FlowRow flow={item} onPress={onOpen} now={now} labels={labels} />
      )}
    />
  );
}
