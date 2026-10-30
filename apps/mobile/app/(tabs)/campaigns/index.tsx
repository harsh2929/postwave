/**
 * Campaigns screen — the workspace's campaign list.
 *
 * What changed here, and why:
 *
 *  - CREATE. Mobile had no create route at all, so a phone operator could
 *    inspect and send existing work but never begin anything — and the shared
 *    empty-state CTA ("Create a campaign") resolved back to this same screen.
 *    The header now opens CampaignCreateModal, and the empty state's primary
 *    action opens it too instead of navigating to itself.
 *  - HONEST CHIP COUNTS. The counts were computed over the pages fetched so
 *    far, so a 900-campaign workspace showed "Draft 100 / Scheduled 0 / Sent 0"
 *    on first paint next to a header reading "more available". They now come
 *    from GET /api/v1/campaigns/count, which honours the same search filter.
 *  - A "NEEDS ATTENTION" BUCKET. Failed and cancelled campaigns were filed
 *    under a chip labelled "Sent" — the app camouflaged a failed send.
 *  - A BOUNDED AUTO-PAGER (see useCampaignListPaging).
 *  - ROW ACTIONS. Duplicate and delete are now a swipe — and a VoiceOver rotor
 *    action — away, with toasts instead of blocking alerts.
 *  - THE FULL STATE LADDER (see CampaignListEmpty): error never renders as
 *    "nothing here", offline is its own message, and the first load is a
 *    skeleton rather than the literal string "Loading…".
 *  - A SORT AXIS. The list was permanently in server order, so "which campaign
 *    performed best?" meant scrolling two hundred rows comparing percentages
 *    by eye. Sorting is client-side over the loaded pages — and says so when
 *    more pages remain, because ranking 100 of 900 rows and calling the top
 *    one the best would be worse than not ranking at all. The choice is
 *    remembered per workspace (useListPreferences).
 *  - REMEMBERED SCROLL POSITION. On a screen designed around infinite
 *    pagination, returning from a campaign dropped you at the top of a list
 *    you had spent several fetches getting to the bottom of.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { type ListRenderItem, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  CachedSessionNotice,
  cachedSessionNotice,
} from "@/components/CachedSessionNotice";
import { ErrorState } from "@/components/ErrorState";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonList } from "@/components/Skeleton";
import { CampaignAgendaHeader } from "@/components/campaigns/CampaignAgendaHeader";
import { CampaignBulkLayer } from "@/components/campaigns/CampaignBulkLayer";
import { CampaignListBody } from "@/components/campaigns/CampaignListBody";
import { CampaignCreateModal } from "@/components/campaigns/CampaignCreateModal";
import { CampaignFilterBar } from "@/components/campaigns/CampaignFilterBar";
import { CampaignListEmpty } from "@/components/campaigns/CampaignListEmpty";
import { CampaignListRow } from "@/components/campaigns/CampaignListRow";
import { CampaignScheduleOutlook } from "@/components/campaigns/CampaignScheduleOutlook";
import { ActionButton } from "@/components/campaigns/CampaignDetailControls";
import { CAMPAIGN_CREATE_PARAM } from "@/components/onboarding/onboardingRoutes";
import { useTourTarget } from "@/components/tour/TourProvider";
import { useCampaignAccess } from "@/hooks/useCampaignAccess";
import {
  CAMPAIGN_AUTO_PAGE_LIMIT,
  useCampaignListPaging,
} from "@/hooks/useCampaignListPaging";
import { useCampaignAgendaDayLens } from "@/hooks/useCampaignAgendaDayLens";
import { useCampaignRowActions } from "@/hooks/useCampaignRowActions";
import { useCampaignViewControls } from "@/hooks/useCampaignViewControls";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useCampaignSelection } from "@/hooks/useCampaignSelection";
import { useCampaignCounts } from "@/hooks/useCampaignCounts";
import { useCampaignsPaginated, type Campaign } from "@/hooks/useCampaigns";
import { useDebounced } from "@/hooks/useDebounced";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useRestoreListScroll } from "@/hooks/useRestoreListScroll";
import { type AgendaEntry } from "@/lib/campaignAgenda";
import {
  campaignFolderCaveat,
  campaignFolderOptions,
  matchesCampaignFolder,
} from "@/lib/campaignFolders";
import { campaignSortCaveat, sortCampaignRows } from "@/lib/campaignSort";
import { campaignsQueryRootKey } from "@/lib/detailSeedKeys";
import { useFirstPageRefresh } from "@/hooks/useFirstPageRefresh";
import {
  bucketCountsFromRows,
  CAMPAIGN_STATUS_FILTERS,
  matchesCampaignStatus,
  type CampaignStatusFilter,
} from "@/lib/campaignStatusFilter";
import { msg, pluralMsg } from "@/lib/i18n";
import { useTheme } from "@/lib/theme";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function Campaigns() {
  const { t } = useTheme();
  const onlineGate = useOnlineQueryGate();
  const gateNotice = cachedSessionNotice({
    gateEnabled: onlineGate.enabled,
    hasTenant: Boolean(onlineGate.tenantId),
    surface: "campaigns",
  });
  const access = useCampaignAccess({ sessionUsable: !gateNotice });

  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const debouncedQuery = useDebounced(query, 250);

  // Status bucket / folder / sort, their persistence rules, and the layout
  // transition that makes changing one read as a filter rather than a redraw.
  const { filter, folder, sort, agenda, changeFilter, changeFolder, changeSort } =
    useCampaignViewControls();

  // The shared onboarding CTA "Create a campaign" (routeKey campaigns.new)
  // used to resolve to this screen, so the tap did nothing visible. It now
  // arrives with ?new=1 and opens the sheet, then clears the flag so a back
  // navigation or a tab re-focus doesn't reopen it.
  const params = useLocalSearchParams<{ new?: string }>();
  const wantsCreate = params[CAMPAIGN_CREATE_PARAM] === "1";
  useEffect(() => {
    if (!wantsCreate) return;
    setCreateOpen(true);
    router.setParams({ [CAMPAIGN_CREATE_PARAM]: undefined });
  }, [wantsCreate]);

  const campaigns = useCampaignsPaginated(debouncedQuery);
  const serverCounts = useCampaignCounts(debouncedQuery);
  const rowActionsFor = useCampaignRowActions(access);

  const pages = campaigns.data?.pages;
  const allItems = useMemo(() => pages?.flatMap((page) => page) ?? [], [pages]);

  const items = useMemo(
    () =>
      sortCampaignRows(
        allItems.filter(
          (c) =>
            matchesCampaignStatus(c.status, filter) &&
            matchesCampaignFolder(c, folder),
        ),
        sort,
      ),
    [allItems, filter, folder, sort],
  );

  // The month grid's day lens over the visible list + the one entry shape
  // both view modes share (hooks/useCampaignAgendaDayLens has the reasoning).
  const lens = useCampaignAgendaDayLens(agenda, items);

  // Workspace-wide counts when the endpoint answers; the loaded window only
  // as a fallback, so a chip never silently understates reality.
  const localCounts = useMemo(() => bucketCountsFromRows(allItems), [allItems]);
  const counts = serverCounts.data ?? localCounts;

  const paging = useCampaignListPaging({
    filter,
    query: debouncedQuery,
    matchCount: items.length,
    hasNextPage: campaigns.hasNextPage,
    isFetchingNextPage: campaigns.isFetchingNextPage,
    isError: campaigns.isError,
    fetchNextPage: campaigns.fetchNextPage,
    counts: serverCounts.data ?? null,
  });

  // Multi-select. Long-press a row to enter it; the bar below carries tag,
  // move-to-folder, compare, export and delete. `visible` is the FILTERED,
  // SORTED list, so a verb can only ever act on rows the operator can see.
  const selection = useCampaignSelection({
    visible: lens.rows,
    canMutate: access.canMutate,
    blockedReason: access.notice ?? null,
    exportScope: exportScope(
      Boolean(campaigns.hasNextPage),
      debouncedQuery,
      filter,
    ),
  });

  // The control that opens the create sheet, so VoiceOver focus returns to
  // "New" when the sheet is dismissed instead of jumping to the top of the
  // screen (see the RETURN FOCUS note in KeyboardFormSheet).
  const createButtonRef = useRef<View | null>(null);

  const listRef = useRef<View>(null);
  useTourTarget("campaigns.list", listRef);
  const scroll = useRestoreListScroll<AgendaEntry<Campaign>>("campaigns");

  const keyExtractor = useCallback(
    (entry: AgendaEntry<Campaign>) => entry.key,
    [],
  );
  // Pull-to-refresh through the shared hook rather than a hand-rolled pair.
  // The spinner used to be bound to `campaigns.isFetching`, which is true for
  // every BACKGROUND refetch this screen makes — a tab re-focus, a window
  // regaining focus, an invalidation after a row action — so the control span
  // and retracted on its own, a phantom gesture the operator never made. It
  // also fires the completion tick, so the app's single most-repeated list
  // gesture stops being the one deliberate action that answers with nothing.
  // The list refetch is bounded to one page (see useFirstPageRefresh) — except
  // while a status chip or folder is applied, which are filtered CLIENT-side
  // across every loaded page, so the pages below the fold are load-bearing.
  const refreshCampaigns = useFirstPageRefresh(
    campaignsQueryRootKey(onlineGate.tenantId),
    campaigns.refetch,
    { collapse: filter === "all" && folder === null },
  );
  const refresh = useManualRefresh([refreshCampaigns, serverCounts.refetch], {
    enabled: !gateNotice,
  });

  // Destructured rather than closing over `selection`: the controller object
  // is rebuilt on every render, and depending on it here would give the
  // FlatList a fresh `renderItem` each time — re-rendering every row of a list
  // designed to hold hundreds. These four members are individually stable
  // (`isSelected` changes only when the selection itself does, which is
  // exactly when the rows must repaint).
  const {
    active: selecting,
    isSelected,
    toggle: toggleSelect,
    begin: beginSelect,
  } = selection;
  const canMutate = access.canMutate;

  const renderCampaign = useCallback<ListRenderItem<AgendaEntry<Campaign>>>(
    ({ item: entry }) => {
      if (entry.kind === "header") {
        return <CampaignAgendaHeader entry={entry} />;
      }
      const c = entry.campaign;
      // Swipe actions are suppressed in selection mode: a swipe that deleted
      // one row while a bulk delete was being assembled is the exact class of
      // misfire multi-select exists to avoid.
      const actions = selecting ? [] : rowActionsFor(c);
      return (
        <CampaignListRow
          campaign={c}
          {...(actions.length > 0 ? { actions } : {})}
          selecting={selecting}
          selected={isSelected(String(c.id))}
          onToggleSelect={toggleSelect}
          {...(canMutate || selecting ? { onBeginSelect: beginSelect } : {})}
        />
      );
    },
    [beginSelect, canMutate, isSelected, rowActionsFor, selecting, toggleSelect],
  );

  const openCreate = useCallback(() => setCreateOpen(true), []);

  const folderRows = selection.folders.data;
  const folderOptions = useMemo(
    () => campaignFolderOptions(folderRows ?? [], folder),
    [folderRows, folder],
  );
  const folderCaveat = campaignFolderCaveat(
    folder,
    Boolean(campaigns.hasNextPage),
    allItems.length,
  );

  // The key is chosen BEFORE the call: the i18n ratchet only recognises a
  // literal that is syntactically the first argument of msg()/pluralMsg(), and
  // a ternary in the argument slot hides it.
  const shownKey = campaigns.hasNextPage
    ? "campaigns.subtitle.shownMore"
    : "campaigns.subtitle.shown";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title={msg("campaigns.title")}
        subtitle={
          campaigns.data ? pluralMsg(shownKey, lens.rows.length) : undefined
        }
        // The filter bar below searches CAMPAIGNS; this magnifier opens the
        // global palette (screens, subscribers, tags…), the same split desktop
        // draws between a page filter and ⌘K.
        onSearch
        right={
          <ActionButton
            label={msg("campaigns.action.new")}
            primary
            onPress={openCreate}
            disabled={!access.canMutate}
            buttonRef={createButtonRef}
          />
        }
      />

      <CampaignFilterBar
        query={query}
        onQueryChange={setQuery}
        resultCount={
          query.trim().length > 0 && campaigns.data ? lens.rows.length : null
        }
        filter={filter}
        onFilterChange={changeFilter}
        counts={counts}
        sort={sort}
        onSortChange={changeSort}
        sortCaveat={campaignSortCaveat(
          sort,
          Boolean(campaigns.hasNextPage),
          allItems.length,
        )}
        agenda={agenda}
        folder={folder}
        onFolderChange={changeFolder}
        folderOptions={folderOptions}
        folderCaveat={folderCaveat}
      />

      {agenda ? (
        <CampaignScheduleOutlook
          rows={items}
          selectedDay={lens.day}
          onSelectDay={lens.setDay}
        />
      ) : null}

      {gateNotice && allItems.length > 0 ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <CachedSessionNotice notice={gateNotice} variant="stale" />
        </View>
      ) : null}

      <CampaignListBody
        entries={lens.entries}
        keyExtractor={keyExtractor}
        renderItem={renderCampaign}
        scroll={scroll}
        containerRef={listRef}
        refreshing={refresh.refreshing}
        onRefresh={refresh.onRefresh}
        onEndReached={() => {
          if (campaigns.hasNextPage && !campaigns.isFetchingNextPage) {
            void campaigns.fetchNextPage();
          }
        }}
        empty={
          <CampaignListEmpty
            isError={campaigns.isError}
            error={campaigns.error}
            onRetry={() => void campaigns.refetch()}
            firstLoad={campaigns.isLoading && allItems.length === 0}
            gateNotice={gateNotice}
            filter={filter}
            query={query}
            draining={paging.draining}
            capped={paging.capped}
            autoPageLimit={CAMPAIGN_AUTO_PAGE_LIMIT}
            onLoadMore={paging.loadMore}
            canCreate={access.canMutate}
            onCreate={openCreate}
          />
        }
        footer={
          campaigns.isError && allItems.length > 0 ? (
            <View style={{ marginTop: 8 }}>
              <ErrorState
                compact
                error={campaigns.error}
                onRetry={() => void campaigns.refetch()}
              />
            </View>
          ) : campaigns.isFetchingNextPage ? (
            <View style={{ marginTop: 8 }}>
              <SkeletonList rows={2} />
            </View>
          ) : null
        }
      />

      <CampaignBulkLayer selection={selection} />

      <CampaignCreateModal
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        canCreate={access.canMutate}
        blockedReason={access.notice}
        returnFocusRef={createButtonRef}
      />
    </SafeAreaView>
  );
}

/**
 * What an export of the current view actually contains — the caveat line that
 * gets pasted above the CSV. Module scope rather than inline so the screen
 * component stays inside its length budget and the derivation is nameable.
 */
function exportScope(
  moreAvailable: boolean,
  query: string,
  filter: CampaignStatusFilter,
) {
  const trimmed = query.trim();
  const label = CAMPAIGN_STATUS_FILTERS.find((f) => f.key === filter)?.label;
  return {
    moreAvailable,
    ...(trimmed ? { query: trimmed } : {}),
    ...(filter === "all" ? {} : { filterLabel: label ?? filter }),
  };
}
