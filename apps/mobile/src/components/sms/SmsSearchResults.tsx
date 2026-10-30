/**
 * SmsSearchResults — the server-side search slice of the SMS inbox.
 *
 * Rendered by `app/(tabs)/sms/index.tsx` in place of the filtered list while a
 * submitted query is active. Owns its own query hook so the screen adds one
 * state variable, not a second data pipeline. Rows are the same
 * `SmsConversationRow` the list uses — a match navigates to the thread, and
 * triage stays available on it.
 */
import { useMemo } from "react";
import { FlatList, Text, View } from "react-native";

import { QueryStates } from "@/components/QueryStates";
import { SkeletonList } from "@/components/Skeleton";
import { LoadMoreButton } from "@/components/sms/SmsInboxParts";
import { SmsConversationRow } from "@/components/sms/SmsConversationRow";
import { useSmsConversationSearch } from "@/hooks/useSmsInboxOps";
import type { SmsInboxAccess } from "@/hooks/useSmsInbox";
import { FONT } from "@/lib/fonts";
import { dateTime, plural } from "@/lib/format";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import type { SmsConversationSummary } from "@/lib/smsConversation";
import { mergeSmsSearchPages } from "@/lib/smsInboxSearch";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SmsSearchResults({
  query,
  access,
  now,
  currentUserId,
  onTriage,
}: {
  /** The SUBMITTED query — already length-gated by the screen. */
  query: string;
  access: SmsInboxAccess;
  now: number;
  currentUserId: string | null;
  onTriage: (conversation: SmsConversationSummary) => void;
}) {
  const { t } = useTheme();
  const search = useSmsConversationSearch(query, access);
  const merged = useMemo(() => {
    if (!search.data) return { value: null, error: null };
    try {
      return { value: mergeSmsSearchPages(search.data.pages), error: null };
    } catch (error) {
      return { value: null, error };
    }
  }, [search.data]);
  if (merged.error) {
    return (
      <View style={{ padding: 16 }}>
        <Text
          {...typeCap("body")}
          style={{
            color: t.danger,
            ...typeStyle("body"),
            fontFamily: FONT.medium,
          }}
        >
          The search response failed its tenant, ordering, or response-cutoff
          checks. No matches were shown.
        </Text>
      </View>
    );
  }
  const rows = merged.value?.conversations ?? [];
  const loadingMore = search.isFetchingNextPage;
  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => row.phoneE164}
      contentContainerStyle={{
        padding: 16,
        paddingTop: 12,
        paddingBottom: 32,
        flexGrow: 1,
      }}
      {...MOBILE_LIST_PERF_PROPS}
      ListHeaderComponent={
        merged.value ? (
          <Text
            accessibilityLiveRegion="polite"
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.medium,
              marginBottom: 10,
            }}
          >
            {`${plural(rows.length, "match", "matches")} shown${
              merged.value.hasMore ? " · more are available" : ""
            }${
              merged.value.snapshotAt
                ? ` · response cutoff ${dateTime(merged.value.snapshotAt)}`
                : ""
            }`}
          </Text>
        ) : null
      }
      ListFooterComponent={
        search.hasNextPage ? (
          <LoadMoreButton
            label={loadingMore ? "Loading…" : "Load more matches"}
            disabled={loadingMore}
            onPress={() => void search.fetchNextPage()}
          />
        ) : null
      }
      ListEmptyComponent={
        <QueryStates
          query={search}
          gate={{ enabled: access.canRequest }}
          isEmpty={rows.length === 0}
          offlineMessage="You're offline. Search needs a connection — nothing was requested."
          skeleton={<SkeletonList rows={4} />}
          empty={{
            title: "No conversations matched",
            description:
              "Message text, phone numbers, and subscriber emails were searched at the response cutoff.",
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
        />
      )}
    />
  );
}
