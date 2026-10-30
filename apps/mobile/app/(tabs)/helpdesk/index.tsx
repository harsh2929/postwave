/** Exact-admin Helpdesk record queue with tenant-bound cursor pagination. */
import { router, useIsFocused } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ErrorState } from "@/components/ErrorState";
import { QueryStates } from "@/components/QueryStates";
import { RoleGateNotice } from "@/components/RoleGateNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonList } from "@/components/Skeleton";
import { CustomerHubHeaderButton } from "@/components/helpdesk/CustomerHubHeaderButton";
import { HelpdeskConversationRow } from "@/components/helpdesk/HelpdeskConversationRow";
import { HelpdeskStatusChips } from "@/components/helpdesk/HelpdeskStatusChips";
import {
  useHelpdeskAccess,
  useHelpdeskCatalog,
  useHelpdeskConversations,
} from "@/hooks/useHelpdesk";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  activeConversationCount,
  HELPDESK_SCOPE_NOTE,
  humanizeToken,
  mergeHelpdeskConversationPages,
} from "@/lib/helpdesk";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function HelpdeskQueue() {
  const { t } = useTheme();
  const focused = useIsFocused();
  const access = useHelpdeskAccess(focused);
  const [status, setStatus] = useState<string | null>(null);
  useScreenViewed("helpdesk");

  const catalog = useHelpdeskCatalog(access);
  const conversations = useHelpdeskConversations(status, access);
  const refresh = useRefreshControl({
    isRefetching: conversations.isRefetching,
    refetch: conversations.refreshFirstPage,
  });
  const merged = useMemo(() => {
    if (!conversations.data) return { rows: [], error: null };
    try {
      return {
        rows: mergeHelpdeskConversationPages(conversations.data.pages),
        error: null,
      };
    } catch (error) {
      return { rows: [], error };
    }
  }, [conversations.data]);
  const active = conversations.data
    ? activeConversationCount(merged.rows)
    : null;

  if (!access.roleAllowed) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <ScreenHeader title="Helpdesk" onBack={goBackOrMore} />
        <View style={{ padding: 16 }}>
          <RoleGateNotice
            title="Owner or admin session required"
            body={
              access.denialReason ??
              "Helpdesk records were not requested for this session."
            }
          />
        </View>
      </SafeAreaView>
    );
  }

  if (merged.error) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <ScreenHeader title="Helpdesk" onBack={goBackOrMore} />
        <View style={{ padding: 16 }}>
          <ErrorState
            message="The Helpdesk response failed its tenant, cursor, ordering, or content-control checks. No customer records were shown."
            onRetry={() => void conversations.refreshFirstPage()}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Helpdesk"
        {...(active !== null
          ? { subtitle: plural(active, "active conversation") + " loaded" }
          : {})}
        onBack={goBackOrMore}
        right={<CustomerHubHeaderButton access={access} />}
      />
      <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 8 }}>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {HELPDESK_SCOPE_NOTE}
        </Text>
        {catalog.isError ? (
          <ErrorState
            compact
            message="The status catalog could not be verified. Recorded queue rows remain visible, but status filters are held."
            onRetry={() => void catalog.refetch()}
          />
        ) : catalog.isPending ? (
          <Text
            accessibilityLiveRegion="polite"
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            Verifying the status catalog…
          </Text>
        ) : catalog.data?.statuses.length ? (
          <HelpdeskStatusChips
            statuses={catalog.data.statuses}
            value={status}
            onSelect={setStatus}
            includeAll
            accessibilityLabel="Filter conversations by status"
            actionVerb="Show"
          />
        ) : (
          <Text
            accessibilityLiveRegion="polite"
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            The verified catalog contains no status filters.
          </Text>
        )}
      </View>
      <FlatList
        data={merged.rows}
        keyExtractor={(row) => row.id}
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
            enabled={access.canRequest}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        onEndReached={() => {
          if (conversations.hasNextPage && !conversations.isFetchingNextPage) {
            void conversations.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.35}
        {...MOBILE_LIST_PERF_PROPS}
        ListEmptyComponent={
          <QueryStates
            query={conversations}
            gate={{ enabled: access.canRequest }}
            isEmpty={merged.rows.length === 0}
            offlineMessage={
              access.online
                ? "Helpdesk is waiting for a verified owner/admin session and context epoch. No private records were requested."
                : "You are offline. Helpdesk records are not stored on this device, so no queue state is shown."
            }
            skeleton={<SkeletonList rows={6} />}
            empty={{
              title: status
                ? "Nothing " + humanizeToken(status).toLowerCase()
                : "No bounded conversations recorded",
              description: status
                ? "Try the All filter to inspect every recorded status."
                : "This is only a bounded set of recorded rows. It is not proof of upstream ingestion or that no customer contacted you.",
            }}
          >
            <View />
          </QueryStates>
        }
        ListFooterComponent={
          conversations.isFetchNextPageError ? (
            <ErrorState
              message="The bounded queue cursor could not continue. Restart from the latest first page."
              onRetry={() => void conversations.refreshFirstPage()}
            />
          ) : conversations.isFetchingNextPage ? (
            <Text
              accessibilityLiveRegion="polite"
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                textAlign: "center",
                padding: 12,
              }}
            >
              Loading older records…
            </Text>
          ) : null
        }
        renderItem={({ item: row }) => (
          <HelpdeskConversationRow
            conversation={row}
            onOpen={(conversation) =>
              router.push({
                pathname: "/(tabs)/helpdesk/[id]",
                params: { id: conversation.id },
              })
            }
          />
        )}
      />
    </SafeAreaView>
  );
}
