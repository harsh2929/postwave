/**
 * Lists — the audience-container catalogue.
 *
 * Rows are now tappable and route to /lists/[id]; before this they were
 * plain Views with no route target, so the obvious next gesture did
 * nothing.
 *
 * Search filters client-side over `name` and `description`. That is still
 * correct: the gateway's list endpoint proxies Listmonk's `/api/lists` and
 * forwards only `?query=` — it never passes page/per_page through — so the
 * client genuinely holds whatever the upstream default page returned.
 *
 * That last fact used to be a silent lie in the UI: the stat strip summed
 * `count` over THAT page and printed the result under the label
 * "Subscribers". The client half is fixed — `useListOptions` now carries the
 * envelope's own `total` and src/lib/listInventory.ts refuses to use a
 * workspace noun unless the client can prove it holds every row. Making the
 * numbers COMPLETE (rather than merely honest about being partial) still
 * needs the gateway to forward page/per_page; see the `List` handler in
 * apps/api/internal/lists/lists.go.
 *
 * Pull-to-refresh matters here because list counts move during imports.
 */
import { useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  type ListRenderItem,
  RefreshControl,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  CachedSessionNotice,
  type CachedSessionNoticeContent,
} from "@/components/CachedSessionNotice";
import { Chip } from "@/components/Chip";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SkeletonList } from "@/components/Skeleton";
import { CreateListSheet } from "@/components/lists/CreateListSheet";
import { SunsetPoliciesSheet } from "@/components/lists/SunsetPoliciesSheet";
import { HeaderAction } from "@/components/deliverability/HeaderAction";
import { ListRow as ListRowView } from "@/components/lists/ListRow";
import {
  computeListsInventory,
  ListsStatStrip,
} from "@/components/lists/ListsStatStrip";
import { AudienceNav } from "@/components/subscriber/AudienceNav";
import { useToast } from "@/components/Toast";
import { useDebounced } from "@/hooks/useDebounced";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useCreateList } from "@/hooks/useCreateList";
import { useCreateParam } from "@/hooks/useCreateParam";
import { type ListOption, useListOptions } from "@/hooks/useListOptions";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { relativeTime } from "@/lib/format";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { FONT } from "@/lib/fonts";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import { useAuthStore } from "@/store/auth";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

const LISTS_ROUTE = "/(tabs)/lists";

type TypeFilter = "all" | "public" | "private";

const TYPE_FILTERS: { key: TypeFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "public", label: "Public" },
  { key: "private", label: "Private" },
];

/**
 * The gateway labels lists `public` / `private`; anything missing
 * defaults to `private` (matches desktop's `(type ?? "private")`).
 */
function matchesType(type: string | undefined, filter: TypeFilter): boolean {
  if (filter === "all") return true;
  return (type ?? "private").toLowerCase() === filter;
}

/**
 * Header actions, extracted so the screen function stays under the
 * complexity budget: create (editor-floor) and the sunset-policies entry
 * (admin-floor — withheld, not disabled, below admin).
 */
function ListsHeaderActions({
  canCreate,
  canHygiene,
  onCreate,
  onHygiene,
}: {
  canCreate: boolean;
  canHygiene: boolean;
  onCreate: () => void;
  onHygiene: () => void;
}) {
  if (!canCreate && !canHygiene) return null;
  return (
    <View style={{ flexDirection: "row", gap: 12 }}>
      {canHygiene ? (
        <HeaderAction
          label="Hygiene"
          accessibilityLabel="Sunset policies"
          onPress={onHygiene}
        />
      ) : null}
      {canCreate ? (
        <HeaderAction
          label="+"
          accessibilityLabel="Create a list"
          onPress={onCreate}
        />
      ) : null}
    </View>
  );
}

export default function Lists() {
  useScreenViewed("lists");
  const { t } = useTheme();
  const lists = useListOptions();
  const gate = useOnlineQueryGate();

  // When the online gate is closed (a restored-from-disk session that
  // hasn't been re-validated online yet, or offline) useListOptions stays
  // idle with data undefined — indistinguishable from a genuinely empty
  // workspace. Surface a "reconnect" notice instead of the misleading
  // "No lists yet — create on web" empty state.
  const listsGateNotice: CachedSessionNoticeContent | null = gate.enabled
    ? null
    : gate.tenantId
      ? {
          title: "Reconnect to load lists",
          description:
            "This cached session has not been validated online yet. Reconnect before loading lists.",
          staleMessage:
            "Reconnect before refreshing lists. Showing the last loaded results.",
        }
      : {
          title: "Reconnect your workspace",
          description:
            "This screen needs an authenticated workspace before it can refresh.",
          staleMessage:
            "Reconnect your workspace before refreshing. Showing anything already cached.",
        };

  // A tap on a list hit in Search arrives with the hit's title as `q`, so the
  // list opens already narrowed to the thing the user picked. Without this the
  // query is silently discarded and the tap lands on an unfiltered list —
  // which reads as the search having done nothing.
  const params = useLocalSearchParams<{ q?: string }>();
  const [q, setQ] = useState(typeof params.q === "string" ? params.q : "");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const debouncedQ = useDebounced(q, 200);

  // Array.isArray, not `?? []`. These rows are fed to `.filter` and to
  // `computeListsInventory` (which iterates), so a TRUTHY non-array is
  // "rows is not iterable" rather than an empty catalogue — and the nullish
  // guard never saw it. `useListOptions` is snapshot-backed and
  // `loadSnapshotBacked` returns the stored blob's `value` unchecked, so an
  // older projection shape lands here rather than staying on the wire.
  const allItems: ListOption[] = useMemo(() => {
    const rows = lists.data?.rows;
    return Array.isArray(rows) ? rows : [];
  }, [lists.data]);

  // Stats are computed over every row the client HOLDS, so the strip stays
  // stable as the user narrows the search / filter below. The envelope's own
  // total rides along so the strip can say whether those rows are the whole
  // workspace or one upstream page — see src/lib/listInventory.ts.
  const stats = useMemo(
    () => computeListsInventory(allItems, lists.data?.total ?? null),
    [allItems, lists.data],
  );

  const rows: ListOption[] = useMemo(() => {
    const needle = debouncedQ.trim().toLowerCase();
    return allItems.filter((row) => {
      if (!matchesType(row.type, typeFilter)) return false;
      if (!needle) return true;
      return `${row.name ?? ""} ${row.description ?? ""}`
        .toLowerCase()
        .includes(needle);
    });
  }, [allItems, debouncedQ, typeFilter]);

  const isFiltered = typeFilter !== "all" || debouncedQ.trim().length > 0;
  const hasAnyLists = allItems.length > 0;
  // Counts move during imports and these screens are routinely resumed
  // hours later, so say how old the numbers are instead of implying "live".
  const freshness = relativeTime(lists.dataUpdatedAt || undefined, {
    fallback: "",
  });

  // Stable identities: FlatList compares props shallowly, so inline arrows
  // here would re-render every mounted row on each keystroke.
  const keyExtractor = useCallback(
    (row: ListOption, index: number) =>
      row.id != null ? String(row.id) : `list-${index}`,
    [],
  );
  const renderItem = useCallback<ListRenderItem<ListOption>>(
    ({ item }) => <ListRowView row={item} />,
    [],
  );

  // POST /api/v1/lists is `write:subscribers`, which editorWriteScopes
  // extends to owner|admin|editor — an EDITOR action, not an admin one.
  // Gating it on admin would hide a control an editor may press.
  const online = useIsOnline();
  const authMode = useAuthStore((state) => state.mode);
  const canCreate =
    canAccessMinimumRole("editor", gate.effectiveRole, authMode) &&
    online &&
    !listsGateNotice;
  const [createOpen, setCreateOpen] = useState(false);
  // The palette's "New list" arrives with ?new=1 — the same flag and idiom
  // as campaigns/index.tsx, written once in hooks/useCreateParam.
  useCreateParam(() => setCreateOpen(true));
  // Sunset (list-hygiene) policies — the WHOLE surface is admin-scoped
  // (see lib/listHygiene.ts), so the entry point is withheld, not disabled,
  // below admin. Online-only: every read/write in the sheet is live.
  const canHygiene =
    canAccessMinimumRole("admin", gate.effectiveRole, authMode) &&
    online &&
    !listsGateNotice;
  const [hygieneOpen, setHygieneOpen] = useState(false);
  const { toast } = useToast();
  const createList = useCreateList();
  const submitCreate = (input: Parameters<typeof createList.mutate>[0]) => {
    createList
      .mutateAsync(input)
      .then((created) => {
        setCreateOpen(false);
        toast({
          kind: "success",
          message: `Created “${created?.name ?? input.name}”`,
        });
      })
      .catch((e: unknown) => {
        toast({
          kind: "error",
          message: e instanceof Error ? e.message : "Couldn't create that list.",
        });
      });
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Lists"
        onBack={goBackOrMore}
        right={
          <ListsHeaderActions
            canCreate={canCreate}
            canHygiene={canHygiene}
            onCreate={() => setCreateOpen(true)}
            onHygiene={() => setHygieneOpen(true)}
          />
        }
      />

      {hasAnyLists ? <ListsStatStrip stats={stats} /> : null}

      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: 8,
          gap: 10,
        }}
      >
        <AudienceNav active={LISTS_ROUTE} />
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder="Search lists by name…"
          accessibilityLabel="Search lists by name"
          {...(isFiltered && hasAnyLists ? { resultCount: rows.length } : {})}
          resultNoun="matching list"
        />
        {freshness ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
            numberOfLines={1}
            accessibilityLabel={`Last updated ${freshness}`}
          >
            {`Updated ${freshness}`}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", gap: 6 }}>
          {TYPE_FILTERS.map((f) => (
            <Chip
              key={f.key}
              label={f.label}
              active={typeFilter === f.key}
              onPress={() => setTypeFilter(f.key)}
              accessibilityLabel={`Filter to ${f.label.toLowerCase()} lists`}
            />
          ))}
        </View>
      </View>
      <FlatList
        // Drag-to-dismiss: this screen has a search field, so the keyboard covers
        // roughly half the viewport and nothing else here closes it.
        keyboardDismissMode="on-drag"
        data={rows}
        keyExtractor={keyExtractor}
        // keyboardShouldPersistTaps="handled" (so the first tap on a chip or a
        // row acts instead of only dismissing the search keyboard) now comes
        // from MOBILE_LIST_PERF_PROPS, which every list spreads.
        contentContainerStyle={{
          padding: 16,
          paddingTop: 4,
          paddingBottom: 32,
          flexGrow: 1,
        }}
        refreshControl={
          <RefreshControl
            refreshing={lists.isRefetching}
            onRefresh={() => void lists.refetch()}
            enabled={!listsGateNotice}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        {...MOBILE_LIST_PERF_PROPS}
        ListEmptyComponent={
          // An error is never "nothing here"; offline is its own message.
          lists.isLoading ? (
            <SkeletonList rows={6} />
          ) : lists.isError ? (
            <ErrorState
              error={lists.error}
              onRetry={() => void lists.refetch()}
            />
          ) : listsGateNotice ? (
            <CachedSessionNotice notice={listsGateNotice} />
          ) : isFiltered ? (
            <EmptyState
              title="No lists match"
              description={
                debouncedQ
                  ? `Nothing matches "${debouncedQ}"${typeFilter !== "all" ? ` in ${typeFilter} lists` : ""}.`
                  : `No ${typeFilter} lists yet.`
              }
              cta={{
                label: "Clear filters",
                onPress: () => {
                  setQ("");
                  setTypeFilter("all");
                },
              }}
            />
          ) : (
            <EmptyState
              title="No lists yet"
              // No longer a dead end: POST /api/v1/lists has always existed
              // and an editor can use it from here. A viewer, or an offline
              // session, still gets a truthful description rather than a
              // button that can only fail.
              description={
                canCreate
                  ? "Lists group subscribers you add by hand or by import. Segments, which pick people by rule, live on the Segments screen."
                  : "Lists group subscribers you add by hand or by import. Creating one needs an editor role and a connection."
              }
              {...(canCreate
                ? {
                    cta: {
                      label: "Create a list",
                      onPress: () => setCreateOpen(true),
                    },
                  }
                : {})}
            />
          )
        }
        renderItem={renderItem}
      />
      <CreateListSheet
        visible={createOpen}
        submitting={createList.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={submitCreate}
      />
      <SunsetPoliciesSheet
        visible={hygieneOpen}
        onClose={() => setHygieneOpen(false)}
      />
    </SafeAreaView>
  );
}
