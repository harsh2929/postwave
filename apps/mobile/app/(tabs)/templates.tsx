/**
 * Templates — the campaign design library, and the shortest path from a design
 * to a draft.
 *
 * A complete template registry shipped server-side
 * (`apps/api/internal/campaigntemplates` — catalogue, search, facets, goals,
 * favourites, clone, adapt, generate, import, reference library) and desktop
 * has had a browser for it for as long as it has existed. Mobile had nothing:
 * a phone could look at campaigns that already existed and could not start one
 * from the workspace's own approved designs. That is the wrong shape for this
 * particular job — picking a design from a shelf is browsing, and browsing is
 * something a phone is genuinely better at than a laptop.
 *
 * WHAT THIS SCREEN DOES
 *   Browse and search the library — by goal, by SHELF (All / Gallery / Team /
 *   Mine / Favorites / Archived) and in the server's three sort orders, with
 *   the workspace's stats in one line and the discovery shelf (recently
 *   viewed, saved searches, collections) above the catalog — read one design,
 *   long-press 2–4 into a side-by-side COMPARE, and then either START A
 *   CAMPAIGN from it (a real draft, opened immediately in the campaign screen
 *   that already exists), DUPLICATE it into an editable copy, or ARCHIVE /
 *   RESTORE it (the reversible lifecycle pair — distinct from the DELETE this
 *   surface still deliberately refuses to offer).
 *
 * WHAT IT DELIBERATELY DOES NOT DO, AND WHY
 *   THERE IS NO TEMPLATE EDITOR HERE, and there should not be. Authoring rich
 *   email — HTML and MJML bodies, variable definitions, preview text, block
 *   layout — is a two-pane, wide-canvas, precise-pointer job. A phone-sized
 *   editor for it would be worse than no editor: it would invite someone to
 *   make a change they cannot see the consequences of, to a design that a
 *   whole list is about to receive. So `POST /campaign-templates`,
 *   `PATCH /{id}`, `DELETE /{id}`, `/import`, `/generate`, `/adapt` and
 *   `/from-generated-design` are all reachable from the API and all
 *   deliberately absent from this surface. The screen says so, out loud, in the
 *   sheet — "editing the design itself is a desktop job" — rather than leaving
 *   the operator hunting for a pencil that is not there.
 *
 * THREE SERVER FACTS SHAPE THE UI AND ARE EASY TO MISS
 *   1. THE CATALOGUE CANNOT SHOW YOU THE EMAIL. `Repo.Search` projects
 *      `'' AS body_html, '' AS body_mjml` (catalog.go:182), so the list has no
 *      body at all and the sheet has to re-read the single template before it
 *      can say whether the design contains anything. Until then it says
 *      "Checking the design…" — never "this design is empty".
 *   2. PART OF THIS LIBRARY CANNOT BE USED, AND THE LIST MIXES IT IN. The
 *      reference library (migration 1748) holds competitor emails captured for
 *      inspiration; the server refuses both verbs on them with a 422, as it
 *      does for anything not `approved` + `owned`. `Repo.Search` filters only
 *      `review_status <> 'rejected'`, so those rows arrive alongside usable
 *      ones. lib/templatePolicy evaluates the same gate locally, so a row
 *      states the refusal instead of the operator discovering it after a tap.
 *   3. READING IS viewer-AND-UP, BOTH VERBS ARE editor-AND-UP. That is the
 *      `apikeys.RequireScope` session path, not a doc comment — see the header
 *      of api/campaignTemplates.ts for the exact middleware chain. A viewer
 *      therefore sees the whole library and is told plainly that starting a
 *      campaign needs an editor role, rather than finding out via a 403.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FlatList,
  type ListRenderItem,
  RefreshControl,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { TemplateDetailSheet } from "@/components/templates/TemplateDetailSheet";
import { TemplateRow } from "@/components/templates/TemplateRow";
import { useDebounced } from "@/hooks/useDebounced";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useNowTicker } from "@/hooks/useNowTicker";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useFirstPageRefresh } from "@/hooks/useFirstPageRefresh";
import { templateCatalogQueryRootKey } from "@/lib/detailSeedKeys";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { TemplateBrowseSheet, type TemplateBrowseSource } from "@/components/templates/TemplateBrowseSheet";
import { TemplateCompareBar } from "@/components/templates/TemplateCompareBar";
import { TemplateCompareSheet } from "@/components/templates/TemplateCompareSheet";
import { TemplateLibraryHeader } from "@/components/templates/TemplateLibraryHeader";
import {
  useTemplateCatalog,
  useTemplateDetail,
  useTemplateGoals,
} from "@/hooks/useCampaignTemplates";
import { useTemplateActions } from "@/hooks/useTemplateActions";
import { useTemplateCompareShortlist } from "@/hooks/useTemplateCompareShortlist";
import {
  useRecordTemplateView,
  useTemplateCompare,
} from "@/hooks/useTemplateDiscovery";
import { useTemplateFavoriteToggle } from "@/hooks/useTemplateFavoriteToggle";
import { useTemplateLifecycle } from "@/hooks/useTemplateLifecycle";
import { plural } from "@/lib/format";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import {
  goalQueryValue,
  templateGoalOptions,
  type MobileTemplate,
  type TemplateGoalFilter,
} from "@/lib/templateCatalog";
import type { TemplateShelf, TemplateSort } from "@/lib/templateDiscovery";
import { useTheme } from "@/lib/theme";
import { useAuthStore } from "@/store/auth";

export { AppErrorBoundary as ErrorBoundary };

export default function Templates() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  const now = useNowTicker();
  useScreenViewed("templates");

  const mode = useAuthStore((s) => s.mode);
  const canWrite = canAccessMinimumRole("editor", gate.effectiveRole, mode);

  // A tap on a template hit in Search arrives with the hit's title as `q`
  // (src/api/search.ts registryTarget), and lib/navDeepLinks appends the same
  // suffix to a destination deep link. Without seeding it here the param is
  // routed and then dropped, so the tap lands on the unfiltered library and
  // reads as the search having done nothing.
  const params = useLocalSearchParams<{ q?: string }>();
  const [query, setQuery] = useState(
    typeof params.q === "string" ? params.q : "",
  );
  // …and `useState` reads its initializer ONCE. This route is a hidden
  // `Tabs.Screen` and nothing in app/(tabs)/_layout.tsx sets `unmountOnBlur`,
  // so React Navigation hands a SECOND search hit to the still-mounted screen
  // as new params rather than remounting it. Here the stale query is not only
  // shown, it is SENT: `useTemplateCatalog(debouncedQuery, …)` narrows
  // server-side, so the library would be fetched for the previous search.
  //
  // Keyed on the param VALUE, not on the params object — `useLocalSearchParams`
  // returns a fresh object every render, so an identity-keyed effect would
  // re-seed on every keystroke and fight the typing it exists to preserve.
  const paramQ = typeof params.q === "string" ? params.q : "";
  useEffect(() => {
    if (!paramQ || paramQ === query) return;
    setQuery(paramQ);
    // Deliberately NOT depending on `query`: this must react to the incoming
    // param only, never to the operator's own subsequent typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramQ]);
  // 300ms: this is a network round trip, not a local filter.
  const debouncedQuery = useDebounced(query, 300);
  const [goal, setGoal] = useState<TemplateGoalFilter>("all");
  // The catalog controls (desktop Templates.tsx:696-701): which shelf of the
  // library, and in what order. Both reach the server as query params.
  const [shelf, setShelf] = useState<TemplateShelf>("all");
  const [sortOrder, setSortOrder] = useState<TemplateSort>("recommended");
  // The tapped ROW, not its id. Deriving it back out of `rows` would let a
  // refetch, a filter change, or a page append close the sheet under the
  // operator mid-read, because the row simply stops being in the array.
  const [open, setOpen] = useState<MobileTemplate | null>(null);
  const closeSheet = useCallback(() => setOpen(null), []);
  // A curated feed (collection, or a saved search's results) hosted in its
  // own sheet — see TemplateBrowseSheet on why this is not local filter state.
  const [browse, setBrowse] = useState<TemplateBrowseSource | null>(null);
  // The compare shortlist (long-press). Its read is armed only while the
  // sheet is OPEN — pressing Compare is the read, not the selection.
  const shortlist = useTemplateCompareShortlist();

  const catalog = useTemplateCatalog(
    debouncedQuery,
    goalQueryValue(goal),
    shelf,
    sortOrder,
  );
  const goals = useTemplateGoals();
  const detail = useTemplateDetail(open?.id ?? null);
  const actions = useTemplateActions(closeSheet);
  const lifecycle = useTemplateLifecycle(closeSheet);
  const recordView = useRecordTemplateView();
  const compare = useTemplateCompare(shortlist.open ? shortlist.ids : []);

  // Opening the sheet is what puts a design on the per-user recent shelf —
  // press-driven by contract (api/templateDiscovery), and fire-and-forget: a
  // failed view-record never surfaces over a sheet that opened fine.
  const openTemplate = useCallback(
    (template: MobileTemplate) => {
      setOpen(template);
      if (online) recordView.mutate(template.id);
    },
    [online, recordView],
  );

  // Favouriting is `read`-scoped server-side — every role may star a design —
  // but needs a live session: the row is handed the handler only when online.
  const toggleFavorite = useTemplateFavoriteToggle();
  // Bounded to one page request (see useFirstPageRefresh). Search, goal, shelf
  // and sort are all in the query key, so page one is the whole answer.
  const refreshCatalog = useFirstPageRefresh(
    templateCatalogQueryRootKey(gate.tenantId),
    catalog.refetch,
  );
  const refresh = useManualRefresh([refreshCatalog, goals.refetch]);

  const rows = useMemo(
    () => (Array.isArray(catalog.data?.pages) ? catalog.data?.pages : []).flatMap((page) => page.items),
    [catalog.data],
  );
  // Null when the response carried no `total` — the header then says nothing
  // rather than announcing a library size nobody reported.
  const total = catalog.data?.pages?.[0]?.total ?? null;

  const goalOptions = useMemo(
    () => templateGoalOptions(Array.isArray(goals.data) ? goals.data : []),
    [goals.data],
  );

  const loadMore = useCallback(() => {
    if (catalog.hasNextPage && !catalog.isFetchingNextPage) {
      void catalog.fetchNextPage();
    }
  }, [catalog]);

  const filtered =
    debouncedQuery.trim() !== "" ||
    goal !== "all" ||
    shelf !== "all" ||
    sortOrder !== "recommended";

  // Hoisted: an inline `renderItem` is a fresh function on every render, and
  // VirtualizedList treats a changed row renderer as a reason to re-render
  // every mounted cell — so on this screen every keystroke in the search field
  // above re-rendered the whole visible library.
  const keyExtractor = useCallback((row: MobileTemplate) => row.id, []);
  const renderTemplate = useCallback<ListRenderItem<MobileTemplate>>(
    ({ item }) => (
      <TemplateRow
        template={item}
        onPress={openTemplate}
        busy={actions.busyId === item.id}
        now={now}
        onLongPress={shortlist.toggle}
        compareSelected={shortlist.ids.includes(item.id)}
        {...(online ? { onToggleFavorite: toggleFavorite } : {})}
      />
    ),
    [actions.busyId, now, online, openTemplate, shortlist.ids, shortlist.toggle, toggleFavorite],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Templates"
        {...(total === null
          ? {}
          : { subtitle: `${plural(total, "design")} in this workspace` })}
        onBack={goBackOrMore}
      />

      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 }}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="Search designs…"
          accessibilityLabel="Search templates by name, subject, description, brand or tag"
          resultCount={catalog.data ? rows.length : undefined}
          resultNoun="design"
        />
      </View>

      {/* Kept mounted whenever a goal is ACTIVE even if the rollup came back
          with nothing to offer — otherwise a failed /goals read would strand
          the operator inside a filter with no control left to clear it. */}
      {goalOptions.length > 1 || goal !== "all" ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <SegmentedControl
            accessibilityLabel="Filter designs by goal"
            scrollable
            options={goalOptions}
            value={goal}
            onChange={setGoal}
          />
        </View>
      ) : null}

      <FlatList
        // Drag-to-dismiss: this screen has a search field, so the keyboard covers
        // roughly half the viewport and nothing else here closes it.
        keyboardDismissMode="on-drag"
        data={catalog.data === undefined ? [] : rows}
        keyExtractor={keyExtractor}
        contentContainerStyle={{
          padding: 16,
          paddingTop: 4,
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
        onEndReachedThreshold={0.6}
        onEndReached={loadMore}
        ListHeaderComponent={
          <>
            {canWrite ? null : (
              <MobileScopeNotice
                title="Read-only for your role"
                body="Browsing the library is open to everyone here. Starting a campaign from a design, or duplicating one, needs an editor role."
              />
            )}
            <TemplateLibraryHeader
              online={online}
              shelf={shelf}
              onShelfChange={setShelf}
              sort={sortOrder}
              onSortChange={setSortOrder}
              query={debouncedQuery}
              goal={goalQueryValue(goal)}
              onOpenTemplate={openTemplate}
              onOpenSavedSearch={(search) =>
                setBrowse({ kind: "saved-search", id: search.id, name: search.name })
              }
              onOpenCollection={(collection) =>
                setBrowse({ kind: "collection", id: collection.id, name: collection.name })
              }
            />
          </>
        }
        ListEmptyComponent={
          <QueryStates
            query={catalog}
            gate={gate}
            isEmpty={rows.length === 0}
            skeleton={<SkeletonList rows={6} />}
            offlineMessage="You're offline, so the design library can't be loaded — and a draft made from a design you can't see wouldn't be one you meant. Reconnect and pull to refresh."
            empty={{
              title: filtered ? "Nothing matches" : "No designs yet",
              description: filtered
                ? "Search covers every design in the library, not just this page — try different words, or clear the goal filter."
                : "Designs saved on desktop, imported from another provider, or generated from a brief all show up here.",
            }}
          >
            {null}
          </QueryStates>
        }
        renderItem={renderTemplate}
      />

      <TemplateCompareBar
        count={shortlist.ids.length}
        onCompare={shortlist.openSheet}
        onClear={shortlist.clear}
      />

      {/* Rendered ONCE, hosted wherever the front-most modal is: iOS stacks a
          modal presented from a modal but refuses a sibling, so while a
          curated feed is open the detail sheet lives inside ITS tree. */}
      {(() => {
        const detailSheet = (
          <TemplateDetailSheet
            template={open}
            detail={detail.data ?? null}
            detailLoading={detail.isLoading}
            detailFailed={detail.isError}
            onClose={closeSheet}
            canWrite={canWrite}
            online={online}
            starting={actions.starting}
            duplicating={actions.duplicating}
            onStartCampaign={(template) => void actions.startCampaign(template)}
            onDuplicate={(template) => void actions.duplicate(template)}
            onToggleArchived={(template) =>
              void lifecycle.toggleArchived(template)
            }
            archiveToggling={lifecycle.pending}
          />
        );
        return (
          <>
            {browse === null ? detailSheet : null}
            <TemplateBrowseSheet
              source={browse}
              onClose={() => setBrowse(null)}
              onOpenTemplate={openTemplate}
              now={now}
              detailSheet={browse === null ? null : detailSheet}
            />
          </>
        );
      })()}

      <TemplateCompareSheet
        visible={shortlist.open}
        onClose={shortlist.closeSheet}
        result={compare.data ?? null}
        loading={compare.isLoading}
        failed={compare.isError}
      />
    </SafeAreaView>
  );
}
