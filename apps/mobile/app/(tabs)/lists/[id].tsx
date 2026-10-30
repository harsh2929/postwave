/**
 * List detail — overview, growth, members, and activity.
 *
 * List rows on mobile used to dead-end: they were plain Views with no
 * route target, so "tap a list to see who's in it" did nothing. Desktop
 * has an eleven-tab slideover; this ships the sections that answer the
 * questions you actually have on a phone:
 *
 *   Overview  type / opt-in / description + the server's A–F health grade,
 *             the suppression/forms/automations cross-references, and the
 *             editor-floor manage actions (edit settings, delete)
 *   Growth    daily added vs removed over the window, plus the net delta
 *             and the engagement breakdown
 *   Members   a paginated, searchable membership list with press-driven
 *             health and engagement checks over the loaded rows, plus the
 *             editor-floor membership writes (add members, swipe to remove)
 *   Activity  the per-list feed (subscribes/unsubscribes/suppressions)
 *
 * The members list is backed by GET /api/v1/lists/{id}/subscribers — NOT
 * the SDK's `list_id` param on /api/v1/subscribers, which the Go handler
 * silently ignores and which would therefore return the ENTIRE tenant
 * while looking correct.
 */
import { useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  FlatList,
  type ListRenderItem,
  RefreshControl,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { CachedSessionNotice } from "@/components/CachedSessionNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SegmentedControl } from "@/components/SegmentedControl";
import {
  ListGrowthCard,
  ListMembersHeader,
  ListOverviewCard,
} from "@/components/lists/ListDetailCards";
import { ListGrowthSourcesCard } from "@/components/lists/ListGrowthSourcesCard";
import {
  ListActivityCard,
  ListCrossRefsCard,
  ListEngagementCard,
} from "@/components/lists/ListInsightCards";
import { ListManageActions } from "@/components/lists/ListManageActions";
import { ListMemberEngagementCard } from "@/components/lists/ListMemberEngagementCard";
import { ListMemberHealthCard } from "@/components/lists/ListMemberHealthCard";
import { ListMemberRow } from "@/components/lists/ListMemberRow";
import { ListMembershipActions } from "@/components/lists/ListMembershipActions";
import { useDebounced } from "@/hooks/useDebounced";
import {
  listDetailKey,
  useListGrowth,
  useListGrowthSources,
  useListHealth,
  useListMembers,
} from "@/hooks/useListDetail";
import { useListMemberRemoval } from "@/hooks/useListMembership";
import { findListOption, useListOptions } from "@/hooks/useListOptions";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { collapseInfiniteQueriesToFirstPage } from "@/lib/infiniteQueryRefresh";
import { useRecordLastViewed } from "@/hooks/useActivityCursor";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import type { ListMember } from "@/api/listDetail";
import { audienceGateNotice } from "@/lib/audienceGateNotice";
import { plural } from "@/lib/format";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOr } from "@/lib/nav";
import { useTheme } from "@/lib/theme";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

type Section = "overview" | "growth" | "members" | "activity";

const SECTIONS = [
  { value: "overview" as const, label: "Overview" },
  { value: "growth" as const, label: "Growth" },
  { value: "members" as const, label: "Members" },
  { value: "activity" as const, label: "Activity" },
];

export default function ListDetail() {
  useScreenViewed("list-detail");
  const { t } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  // Cross-device continuity: tell the server this is where the user is,
  // so their other devices can offer "Continue". Best-effort and silent.
  useRecordLastViewed("list", id);
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  const gateNotice = audienceGateNotice({
    gateEnabled: gate.enabled,
    hasTenant: Boolean(gate.tenantId),
    noun: "this list",
  });

  const [section, setSection] = useState<Section>("overview");
  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q, 250);

  const catalogue = useListOptions();
  const list = findListOption(catalogue.data?.rows, id);
  const growth = useListGrowth(id);
  // "Where are new subscribers coming from" — the glanceable number the
  // mobile list detail was missing. Fetched only while the Growth section is
  // on screen, so opening a list costs one request rather than four.
  const growthSources = useListGrowthSources(
    section === "growth" ? id : undefined,
  );
  const health = useListHealth(id);
  // The roster is PII. Keep its query structurally disabled until the
  // operator opens Members; merely visiting Overview or Growth must not load
  // dormant subscriber rows into memory.
  const members = useListMembers(
    section === "members" ? id : undefined,
    debouncedQ,
  );

  const memberRows: ListMember[] = useMemo(
    () =>
      (Array.isArray(members.data?.pages) ? members.data?.pages : []).flatMap(
        (page) => page.items,
      ),
    [members.data],
  );
  const memberTotal = members.data?.pages.at(-1)?.total;
  const showingMembers = section === "members";

  // Taking someone off THIS list, from this list — the verb that used to
  // require a detour through each person's profile. Withheld (onRemove
  // undefined) below editor and while the gate is closed; see the hook.
  const listName = list?.name ?? "this list";
  const removal = useListMemberRemoval(id, listName);
  const { onRemove, removingId } = removal;

  const keyExtractor = useCallback(
    (item: ListMember, index: number) => item.id || `${item.email}-${index}`,
    [],
  );
  const renderMember = useCallback<ListRenderItem<ListMember>>(
    ({ item }) => (
      <View style={{ marginBottom: 8 }}>
        <ListMemberRow
          item={item}
          onRemove={onRemove}
          removing={removingId === item.id}
        />
      </View>
    ),
    [onRemove, removingId],
  );

  const hasNextPage = members.hasNextPage;
  const fetchingNext = members.isFetchingNextPage;
  const fetchNextPage = members.fetchNextPage;
  const onEndReached = useCallback(() => {
    if (gateNotice || !hasNextPage || fetchingNext) return;
    void fetchNextPage();
  }, [fetchNextPage, fetchingNext, gateNotice, hasNextPage]);

  const onRefresh = useCallback(() => {
    void catalogue.refetch();
    void growth.refetch();
    void health.refetch();
    // The members list is an infinite query, and TanStack refetches every
    // loaded page of one, sequentially. Collapsing to page one first makes the
    // gesture cost a single request instead of one per page the reader has
    // loaded (lib/infiniteQueryRefresh). The prefix also covers the growth and
    // health entries under the same key family; neither is paged, so
    // `collapseInfiniteQueriesToFirstPage` leaves them untouched.
    collapseInfiniteQueriesToFirstPage(
      queryClient,
      listDetailKey(gate.tenantId, id),
    );
    void members.refetch();
  }, [catalogue, gate.tenantId, growth, health, id, members, queryClient]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title={list?.name ?? "List"}
        {...(typeof list?.count === "number"
          ? { subtitle: plural(list.count, "subscriber") }
          : {})}
        onBack={() => goBackOr("/(tabs)/lists")}
      />
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 4,
          paddingBottom: 8,
          gap: 10,
        }}
      >
        <SegmentedControl
          accessibilityLabel="List section"
          options={SECTIONS}
          value={section}
          onChange={setSection}
        />
        {showingMembers ? (
          <SearchField
            value={q}
            onChangeText={setQ}
            placeholder="Search members…"
            accessibilityLabel="Search list members"
            {...(debouncedQ && typeof memberTotal === "number"
              ? { resultCount: memberTotal }
              : {})}
            resultNoun="matching member"
          />
        ) : null}
        {gateNotice ? <CachedSessionNotice notice={gateNotice} /> : null}
      </View>

      <FlatList
        // Drag-to-dismiss: this screen has a search field, so the keyboard covers
        // roughly half the viewport and nothing else here closes it.
        keyboardDismissMode="on-drag"
        {...MOBILE_LIST_PERF_PROPS}
        data={showingMembers ? memberRows : []}
        keyExtractor={keyExtractor}
        renderItem={renderMember}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          padding: 16,
          paddingTop: 4,
          paddingBottom: 32,
        }}
        onEndReachedThreshold={0.5}
        onEndReached={showingMembers ? onEndReached : undefined}
        refreshControl={
          <RefreshControl
            refreshing={members.isRefetching || growth.isRefetching}
            enabled={!gateNotice}
            onRefresh={onRefresh}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          <View>
            {section === "overview" ? (
              <>
                <ListOverviewCard
                  list={list}
                  catalogueLoading={catalogue.isLoading}
                  blocked={Boolean(gateNotice)}
                  health={health.data}
                  healthLoading={health.isLoading}
                  healthError={health.isError}
                />
                {/* Which suppressions/forms/automations touch THIS list —
                    desktop's three cross-reference tabs as linked counts. */}
                {!gateNotice ? <ListCrossRefsCard listId={id} /> : null}
                {/* Edit settings / delete — editor-floor writes; the card
                    withholds itself for viewers and UUID deep links. */}
                <ListManageActions
                  list={list ?? undefined}
                  blocked={Boolean(gateNotice)}
                />
              </>
            ) : null}

            {section === "growth" ? (
              <>
                <ListGrowthCard
                  growth={growth.data}
                  isLoading={growth.isLoading}
                  isError={growth.isError}
                  error={growth.error}
                  onRetry={() => void growth.refetch()}
                />
                <ListGrowthSourcesCard
                  mix={growthSources.data}
                  isLoading={growthSources.isLoading}
                  isError={growthSources.isError}
                  error={growthSources.error}
                  onRetry={() => void growthSources.refetch()}
                />
                {/* How the list ENGAGES, not just how it grows — desktop's
                    engagement breakdown. Fetched only while Growth is open. */}
                {!gateNotice ? <ListEngagementCard listId={id} /> : null}
              </>
            ) : null}

            {/* The per-list audit feed — desktop's ActivityTab. */}
            {section === "activity" && !gateNotice ? (
              <ListActivityCard listId={id} />
            ) : null}

            {/* Add people to this list without a detour through each
                profile (the card also states the row's remove swipe), then
                the roster itself: error before empty, always. */}
            {showingMembers ? (
              <>
                <ListMembershipActions
                  listId={id}
                  listName={listName}
                  blocked={Boolean(gateNotice)}
                />
                <ListMembersHeader
                  isLoading={members.isLoading}
                  isError={members.isError}
                  error={members.error}
                  onRetry={() => void members.refetch()}
                  blocked={Boolean(gateNotice)}
                  query={debouncedQ}
                  loaded={memberRows.length}
                  total={memberTotal}
                  canAdd={removal.canAct}
                />
              </>
            ) : null}

            {/*
              The bulk half of email health, which had a fully-validated
              client on this device and no caller at all: until now the only
              way to ask whether a roster was mailable was to open its members
              one at a time. Scoped to the LOADED rows and never fired on its
              own — see the card's header for why both of those are the
              honest shape rather than a limitation.
            */}
            {showingMembers ? (
              <ListMemberHealthCard
                emails={memberRows.map((row) => row.email)}
                blocked={Boolean(gateNotice)}
              />
            ) : null}

            {/* Per-member opens/clicks for the loaded rows — desktop's
                per-row engagement column, press-driven like the health
                check above and for the same reasons. */}
            {showingMembers ? (
              <ListMemberEngagementCard
                listId={id}
                memberIds={memberRows.map((row) => row.id)}
                blocked={Boolean(gateNotice)}
              />
            ) : null}
          </View>
        }
        ListFooterComponent={
          fetchingNext ? (
            <View style={{ paddingVertical: 24, alignItems: "center" }}>
              <ActivityIndicator color={t.fgMuted} />
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}
