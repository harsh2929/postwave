/** Read-only, paginated and privacy-minimized Gift history on mobile. */
import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  type ListRenderItem,
  Pressable,
  RefreshControl,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { isGiftAccessDenied } from "@/api/giftSubscriptions";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { GiftFilterBar } from "@/components/gift-subscriptions/GiftFilterBar";
import { GiftObservationList } from "@/components/gift-subscriptions/GiftObservationList";
import {
  GiftRow,
  IDLE_FRESH_READ,
  type GiftFreshRead,
} from "@/components/gift-subscriptions/GiftRow";
import {
  GiftStatsCard,
  type GiftStatsCardState,
} from "@/components/gift-subscriptions/GiftStatsCard";
import { useDebounced } from "@/hooks/useDebounced";
import {
  useGiftStats,
  useGiftSubscription,
  useGiftSubscriptions,
} from "@/hooks/useGiftSubscriptions";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useNowTicker } from "@/hooks/useNowTicker";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useFirstPageRefresh } from "@/hooks/useFirstPageRefresh";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { giftObservations } from "@/lib/giftInsights";
import {
  giftHistoryQueryPrefix,
  mergeGiftHistoryPages,
  sanitizeGiftHistoryQuery,
  type GiftHistoryFilter,
  type GiftHistoryRecord,
  type GiftHistorySort,
} from "@/lib/giftSubscriptions";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function GiftSubscriptionsScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  useScreenViewed("gift-subscriptions");

  const [query, setQuery] = useState("");
  const [acceptedQueryPrefix, setAcceptedQueryPrefix] = useState("");
  const queryPrefix = useDebounced(acceptedQueryPrefix, 250);
  const [filter, setFilter] = useState<GiftHistoryFilter>("all");
  const [sort, setSort] = useState<GiftHistorySort>("newest");
  const gifts = useGiftSubscriptions({ query: queryPrefix, filter, sort });
  const stats = useGiftStats();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const fresh = useGiftSubscription(expandedId);
  const now = Math.floor(useNowTicker() / 60_000) * 60_000;

  const pages = useMemo(() => (Array.isArray(gifts.data?.pages) ? gifts.data?.pages : []), [gifts.data?.pages]);
  const rows = useMemo(() => mergeGiftHistoryPages(pages), [pages]);
  const total = pages[0]?.total ?? null;
  const loaded = gifts.data !== undefined;
  const observations = useMemo(
    () => giftObservations({ pages, stats: stats.data ?? null }),
    [pages, stats.data],
  );
  const statsCardState: GiftStatsCardState = stats.data
    ? { status: "ready", stats: stats.data }
    : stats.isError || !gate.enabled
      ? { status: "unavailable" }
      : stats.isLoading || stats.isPending
        ? { status: "loading" }
        : { status: "unavailable" };
  // Bounded to one page request (see useFirstPageRefresh); the search, filter
  // and sort are all in the query key.
  const refreshGifts = useFirstPageRefresh(
    ["gift-subscriptions", "list", gate.tenantId],
    gifts.refetch,
  );
  const refresh = useManualRefresh([refreshGifts, stats.refetch], {
    enabled: gate.enabled,
  });

  const onToggle = useCallback((id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  }, []);
  const onChangeQuery = useCallback((next: string) => {
    setExpandedId(null);
    const sanitized = sanitizeGiftHistoryQuery(next);
    setQuery(sanitized);
    if (sanitized.trim() === "") {
      setAcceptedQueryPrefix("");
      return;
    }
    const prefix = giftHistoryQueryPrefix(sanitized);
    if (prefix !== undefined) setAcceptedQueryPrefix(prefix);
  }, []);
  const onChangeFilter = useCallback((next: GiftHistoryFilter) => {
    setExpandedId(null);
    setFilter(next);
  }, []);
  const onChangeSort = useCallback((next: GiftHistorySort) => {
    setExpandedId(null);
    setSort(next);
  }, []);
  const freshBinding: GiftFreshRead = useMemo(
    () => ({
      isFetching: fresh.isFetching,
      isError: fresh.isError,
      data: fresh.data,
    }),
    [fresh.data, fresh.isError, fresh.isFetching],
  );
  const keyExtractor = useCallback((gift: GiftHistoryRecord) => gift.id, []);
  const renderRow = useCallback<ListRenderItem<GiftHistoryRecord>>(
    ({ item }) => (
      <GiftRow
        gift={item}
        expanded={expandedId === item.id}
        onToggle={onToggle}
        fresh={expandedId === item.id ? freshBinding : IDLE_FRESH_READ}
        now={now}
      />
    ),
    [expandedId, freshBinding, now, onToggle],
  );

  const denied = isGiftAccessDenied(gifts.error);
  if (denied) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <ScreenHeader title="Gift history" onBack={goBackOrMore} />
        <View style={{ padding: 16 }}>
          <MobileScopeNotice
            title="Your role can't read Gift history"
            body="The server refused this reporting read for the current session. Ask a workspace owner or administrator to review your access."
          />
        </View>
      </SafeAreaView>
    );
  }

  const hasFilters = queryPrefix !== "" || filter !== "all";
  const retainedListError = loaded && gifts.isError;
  const listState = retainedListError
    ? { ...gifts, isError: false, error: null }
    : gifts;
  const reachedServerWindow =
    total !== null &&
    rows.length < total &&
    !gifts.hasNextPage &&
    pages.some(
      (page) => page.offset + page.items.length + page.rejectedRows >= 10_000,
    );
  const subtitle =
    total === null ? undefined : `${plural(total, "record")} in this view`;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Gift history"
        {...(subtitle ? { subtitle } : {})}
        onBack={goBackOrMore}
      />
      <GiftFilterBar
        query={query}
        onChangeQuery={onChangeQuery}
        filter={filter}
        onChangeFilter={onChangeFilter}
        sort={sort}
        onChangeSort={onChangeSort}
        total={total}
      />
      <FlatList
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderRow}
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
            enabled={gate.enabled}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        {...MOBILE_LIST_PERF_PROPS}
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 12 }}>
            <MobileScopeNotice
              title="Lifecycle evidence, without identities"
              body="This is a read-only historical archive. It deliberately excludes recipient and purchaser emails, messages, provider links and redemption material; gift commerce actions remain unavailable."
            />
            {retainedListError ? (
              <MobileScopeNotice
                title="Refresh didn't complete"
                body="Previously loaded, sanitized records remain visible. Pull to try the archive read again."
              />
            ) : null}
            <GiftStatsCard state={statsCardState} now={now} />
            <GiftObservationList items={observations} />
            <SectionLabel topMargin={4}>Archive records</SectionLabel>
          </View>
        }
        ListEmptyComponent={
          <QueryStates
            query={listState}
            gate={gate}
            isEmpty={rows.length === 0}
            offlineMessage="Gift history needs a connection. Reconnect and pull to refresh — offline is not the same as an empty archive."
            skeleton={
              <SkeletonList rows={5} lines={3} label="Loading Gift history" />
            }
            empty={
              hasFilters
                ? {
                    title: "No matching records",
                    description:
                      "Try a shorter record prefix or a different lifecycle filter.",
                  }
                : {
                    title: "No Gift history yet",
                    description:
                      "No sanitized gift lifecycle records are available for this workspace.",
                  }
            }
          >
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              No loaded records match this view.
            </Text>
          </QueryStates>
        }
        ListFooterComponent={
          loaded ? (
            <View style={{ marginTop: 12, gap: 10, alignItems: "center" }}>
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                  textAlign: "center",
                }}
              >
                {total === null
                  ? `${num(rows.length)} records loaded`
                  : `Showing ${num(rows.length)} of ${num(total)} matching records`}
              </Text>
              {reachedServerWindow ? (
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.warning,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                    textAlign: "center",
                  }}
                >
                  This view reached the server&apos;s 10,000-record archive
                  window. Older records require keyset pagination before they
                  can be represented truthfully.
                </Text>
              ) : null}
              {gifts.hasNextPage ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Load more Gift history records"
                  accessibilityState={{
                    disabled: gifts.isFetchingNextPage,
                  }}
                  disabled={gifts.isFetchingNextPage}
                  onPress={() => void gifts.fetchNextPage()}
                  style={{
                    minHeight: 44,
                    minWidth: 160,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: t.borderSubtle,
                    backgroundColor: t.surface,
                  }}
                >
                  <Text
                    {...typeCap("bodySmall")}
                    style={{
                      color: t.fg,
                      ...typeStyle("bodySmall"),
                      fontFamily: FONT.medium,
                    }}
                  >
                    {gifts.isFetchingNextPage ? "Loading…" : "Load more"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}
