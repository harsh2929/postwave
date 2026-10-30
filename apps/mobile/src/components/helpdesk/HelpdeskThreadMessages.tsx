/**
 * HelpdeskThreadMessages — the bounded message window.
 *
 * A merge failure shows NO rows: if the pages failed their tenant, cursor,
 * ordering, delivery-fact or content-control checks, partial evidence is worse
 * than none. Loading older records pauses the latest-window poll upstream, so
 * the header's "load older" and the notices' "restart latest window" are two
 * halves of one decision.
 */
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { QueryStates } from "@/components/QueryStates";
import { SkeletonList } from "@/components/Skeleton";
import { HelpdeskMessageBubble } from "@/components/helpdesk/HelpdeskMessageBubble";
import type { HelpdeskThreadController } from "@/hooks/useHelpdeskThreadScreen";
import { FONT } from "@/lib/fonts";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function HelpdeskThreadMessages({
  screen,
}: {
  screen: HelpdeskThreadController;
}) {
  const { t } = useTheme();
  const { didInitialScroll, listRef, merged, refresh, requestAccess, thread } =
    screen;

  if (merged.error) {
    return (
      <View style={{ padding: 16 }}>
        <ErrorState
          message="The thread failed its tenant, cursor, ordering, delivery-fact, or content-control checks. No message evidence was shown."
          onRetry={() => void thread.refreshLatest()}
        />
      </View>
    );
  }

  return (
    <FlatList
      ref={listRef}
      data={merged.messages}
      keyExtractor={(message) => message.id}
      contentContainerStyle={{
        padding: 16,
        paddingBottom: 8,
        flexGrow: 1,
      }}
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      refreshControl={
        <RefreshControl
          refreshing={refresh.refreshing}
          onRefresh={refresh.onRefresh}
          enabled={requestAccess.canRequest}
          tintColor={t.fgMuted}
          colors={[t.accent]}
        />
      }
      {...MOBILE_LIST_PERF_PROPS}
      onContentSizeChange={() => {
        if (didInitialScroll.current || merged.messages.length === 0) return;
        didInitialScroll.current = true;
        listRef.current?.scrollToEnd({ animated: false });
      }}
      ListHeaderComponent={
        thread.isFetchNextPageError ? (
          <ErrorState
            message="The bounded history cursor could not continue. Restart from the latest window."
            onRetry={() => void thread.refreshLatest()}
          />
        ) : thread.hasNextPage ? (
          <Pressable
            onPress={() => void thread.fetchNextPage()}
            disabled={thread.isFetchingNextPage}
            accessibilityRole="button"
            accessibilityLabel="Load older message records"
            accessibilityState={{ disabled: thread.isFetchingNextPage }}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accent,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
                textAlign: "center",
              }}
            >
              {thread.isFetchingNextPage
                ? "Loading older records…"
                : "Load older records"}
            </Text>
          </Pressable>
        ) : null
      }
      ListEmptyComponent={
        <QueryStates
          query={thread}
          gate={{ enabled: requestAccess.canRequest }}
          isEmpty={merged.messages.length === 0}
          offlineMessage={
            requestAccess.online
              ? "Helpdesk is waiting for a verified owner/admin session and context epoch. No private thread was requested."
              : "You are offline. This private thread is not stored on the device."
          }
          skeleton={<SkeletonList rows={4} lines={2} />}
          empty={{
            title: "No message records",
            description:
              "This conversation exists, but no bounded message record was returned.",
          }}
        >
          <View />
        </QueryStates>
      }
      renderItem={({ item: message }) => (
        <HelpdeskMessageBubble message={message} />
      )}
    />
  );
}
