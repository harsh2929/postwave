/**
 * SmsInboxList — the filtered conversation FlatList of the SMS inbox.
 *
 * Extracted from `app/(tabs)/sms/index.tsx` when search and bulk selection
 * pushed the screen past its source budgets. The screen keeps every hook and
 * all state; this component only renders what it is handed.
 */
import { router } from "expo-router";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";

import { QueryStates } from "@/components/QueryStates";
import { SkeletonList } from "@/components/Skeleton";
import { SmsCampaignControls } from "@/components/sms/SmsCampaignControls";
import { SmsConversationRow } from "@/components/sms/SmsConversationRow";
import {
  emptyTitle,
  FreshnessLine,
  LoadMoreButton,
} from "@/components/sms/SmsInboxParts";
import type { SmsInboxAccess, SmsPollState } from "@/hooks/useSmsInbox";
import { forwardArrow } from "@/lib/direction";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import type {
  SmsConversationFilter,
  SmsConversationStatus,
  SmsConversationSummary,
} from "@/lib/smsConversation";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SmsInboxListProps {
  access: SmsInboxAccess;
  rows: readonly SmsConversationSummary[];
  filter: SmsConversationFilter;
  status: SmsConversationStatus;
  now: number;
  currentUserId: string | null;
  snapshotAt: string | null;
  hasMore: boolean;
  pollState: SmsPollState;
  query: {
    isFetching: boolean;
    isFetchingNextPage: boolean;
    hasNextPage: boolean | undefined;
    isError: boolean;
    isLoading: boolean;
    isSuccess: boolean;
    error?: unknown;
    fetchNextPage: () => Promise<unknown>;
  };
  refreshing: boolean;
  onRefresh: () => void;
  selecting: boolean;
  selected: ReadonlyMap<string, SmsConversationSummary>;
  onToggleSelect: (conversation: SmsConversationSummary) => void;
  onStartSelecting: () => void;
  onTriage: (conversation: SmsConversationSummary) => void;
}

export function SmsInboxList({
  access,
  rows,
  filter,
  status,
  now,
  currentUserId,
  snapshotAt,
  hasMore,
  pollState,
  query,
  refreshing,
  onRefresh,
  selecting,
  selected,
  onToggleSelect,
  onStartSelecting,
  onTriage,
}: SmsInboxListProps) {
  const { t } = useTheme();
  const busyPaging = query.isFetchingNextPage || pollState === "refreshing";
  return (
    <FlatList
      data={rows as SmsConversationSummary[]}
      keyExtractor={(row) => row.phoneE164}
      contentContainerStyle={{
        padding: 16,
        paddingTop: 12,
        paddingBottom: 32,
        flexGrow: 1,
      }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={t.fgMuted}
          colors={[t.accent]}
        />
      }
      {...MOBILE_LIST_PERF_PROPS}
      ListHeaderComponent={
        <View style={{ gap: 10, marginBottom: 10 }}>
          <SmsCampaignControls />
          {access.roleAllowed ? (
            <Pressable
              onPress={() => {
                haptics.tap();
                router.push("/(tabs)/sms/broadcasts");
              }}
              accessibilityRole="button"
              accessibilityLabel="Open SMS broadcasts"
              accessibilityHint="Draft management; dispatch is release-held."
              hitSlop={8}
              style={{ minHeight: 32, justifyContent: "center" }}
            >
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.accent,
                  ...typeStyle("caption"),
                  fontFamily: FONT.semibold,
                }}
              >
                {`SMS broadcasts ${forwardArrow()}`}
              </Text>
            </Pressable>
          ) : null}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <View style={{ flex: 1 }}>
              <FreshnessLine
                online={access.online}
                fetching={query.isFetching || pollState === "refreshing"}
                refreshFailed={pollState === "failed"}
                restartRequired={pollState === "restart_required"}
                snapshotAt={snapshotAt}
                partial={hasMore}
              />
            </View>
            {access.canRequest && rows.length > 0 && !selecting ? (
              <Pressable
                onPress={() => {
                  haptics.tap();
                  onStartSelecting();
                }}
                accessibilityRole="button"
                accessibilityLabel="Select conversations for a bulk action"
                hitSlop={8}
                style={{ minHeight: 32, justifyContent: "center" }}
              >
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.accent,
                    ...typeStyle("caption"),
                    fontFamily: FONT.semibold,
                  }}
                >
                  Select
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      }
      ListFooterComponent={
        query.hasNextPage ? (
          <LoadMoreButton
            label={busyPaging ? "Loading…" : "Load more conversations"}
            disabled={busyPaging}
            onPress={() => void query.fetchNextPage()}
          />
        ) : null
      }
      ListEmptyComponent={
        <QueryStates
          query={query}
          gate={{ enabled: access.canRequest }}
          isEmpty={rows.length === 0}
          offlineMessage="You're offline. No uncached SMS data was requested, and replies remain locked until you reconnect."
          skeleton={<SkeletonList rows={6} />}
          empty={{
            title: emptyTitle(filter, status),
            description:
              filter === "all" && status === "active"
                ? // NOT a promise that replies are coming. All three inbound
                  // SMS webhooks answer 503 behind `smsProviderCallbackReleaseReady`
                  // (apps/api/internal/sms/handlers.go:115), so on this server no
                  // code path can deliver one, and the server says so itself:
                  // the readiness route reports `sms_provider_callback_release_held`
                  // in `blocking_reasons`. Telling an operator their replies
                  // "will appear here" makes the empty list read as "nobody has
                  // replied yet" — a claim about their subscribers — when it is
                  // really a statement about a feature that is switched off.
                  "Inbound replies are not enabled on this server yet, so none can arrive here. Conversations you start are still listed."
                : "Change a filter to inspect another server-confirmed slice.",
          }}
        >
          <View />
        </QueryStates>
      }
      renderItem={({ item }) => (
        <SmsConversationRow
          conversation={item}
          now={now}
          currentUserId={currentUserId}
          canTriage={access.canRequest}
          onTriage={onTriage}
          selectionMode={selecting}
          selected={selected.has(item.phoneE164)}
          onToggleSelect={onToggleSelect}
        />
      )}
    />
  );
}
