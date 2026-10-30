import { useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { desktopRouteIdentityScope } from "../../lib/desktop-router";
import { useCanAdmin, useCanWrite, useMe, useRole } from "../../lib/store";
import { DEFAULT_ORDER, DEFAULT_SORT } from "../subscribers-paging";
import { getSubscribersSubtitle } from "./subscribers-page-utils";
import { useSubscriberDeepLinks } from "./useSubscriberDeepLinks";
import { useSubscriberLiveUpdates } from "./useSubscriberLiveUpdates";
import { useSubscriberRowMutations } from "./useSubscriberRowMutations";
import { useSubscribersData } from "./useSubscribersData";
import { useSubscribersExport } from "./useSubscribersExport";
import { useSubscribersKeyboard } from "./useSubscribersKeyboard";
import { useSubscribersPageState } from "./useSubscribersPageState";
import { useSubscribersSavedSegments } from "./useSubscribersSavedSegments";
import { useSubscribersSelection } from "./useSubscribersSelection";
import { useSubscribersViewPreferences } from "./useSubscribersViewPreferences";

export function useSubscribersPageController() {
  const canMutate = useCanWrite();
  const canAdmin = useCanAdmin();
  const me = useMe();
  const role = useRole();
  const queryClient = useQueryClient();
  const recentSearchScope = desktopRouteIdentityScope(me?.user, me?.tenant);
  const state = useSubscribersPageState();
  const view = useSubscribersViewPreferences(recentSearchScope);
  const data = useSubscribersData({
    state,
    tenantId: me?.tenant ?? null,
    recentSearchScope,
    role,
    queryClient,
  });
  const selection = useSubscribersSelection(state, data);
  const saved = useSubscribersSavedSegments(state, view, recentSearchScope);
  const mutations = useSubscriberRowMutations(
    state,
    data,
    saved.invalidatePreviewCounts,
    recentSearchScope,
  );
  const live = useSubscriberLiveUpdates(
    state,
    data,
    saved.invalidatePreviewCounts,
  );
  const exporter = useSubscribersExport(state, data);
  const importReturnFocusRef = useRef<HTMLElement | null>(null);
  const openCreate = (): void => {
    if (canMutate) state.setCreateOpen(true);
  };
  const openImport = (): void => {
    if (!canAdmin) return;
    importReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    state.setImportOpen(true);
  };
  const closeImport = (): void => {
    state.setImportOpen(false);
    const returnTarget = importReturnFocusRef.current;
    importReturnFocusRef.current = null;
    window.requestAnimationFrame(() => {
      if (returnTarget?.isConnected) returnTarget.focus();
    });
  };

  const deepLinks = useSubscriberDeepLinks({
    state,
    data,
    canMutate,
    canImport: canAdmin,
    identityScope: recentSearchScope,
    openCreate,
  });
  const keyboard = useSubscribersKeyboard({
    state,
    data,
    selection,
    exporter,
    openCreate,
    openSubscriber: deepLinks.openSubscriber,
  });

  const toggleSort = (column: string): void => {
    void state.requestViewChange((current) => ({
      ...current,
      savedSegmentId: null,
      sortColumn: column,
      sortOrder:
        column === current.sortColumn
          ? current.sortOrder === "asc"
            ? "desc"
            : "asc"
          : DEFAULT_ORDER,
      page: 1,
    }));
  };
  const changeFilter = (filter: typeof state.filter): void => {
    void state.requestViewChange((current) => ({
      ...current,
      savedSegmentId: null,
      filter,
      page: 1,
    }));
  };
  const toggleArchived = (): void => {
    void state.requestViewChange((current) => ({
      ...current,
      savedSegmentId: null,
      showArchived: !current.showArchived,
      page: 1,
    }));
  };
  const completeBulkAction = (skipReload?: boolean): void => {
    state.setSelectedKeys(new Set());
    saved.invalidatePreviewCounts();
    if (!skipReload) data.reload();
  };
  const reloadAfterSubscriberMutation = (): void => {
    saved.invalidatePreviewCounts();
    data.reload();
  };
  const resetView = (): void => {
    void state.requestViewChange((current) => ({
      ...current,
      savedSegmentId: null,
      query: "",
      filter: "all",
      showArchived: false,
      sortColumn: DEFAULT_SORT,
      sortOrder: DEFAULT_ORDER,
      page: 1,
    }));
  };
  const updateVisibleColumns = (columns: string[]): void => {
    state.setActiveSavedSegmentId(null);
    view.updateVisibleColumns(columns);
  };

  const added30d = (
    data.dashboardStats as { subscribers_added_30d?: number } | null
  )?.subscribers_added_30d;
  const unsubbed30d = (
    data.dashboardStats as { subscribers_unsubbed_30d?: number } | null
  )?.subscribers_unsubbed_30d;
  const subtitle = getSubscribersSubtitle({
    rows: data.rows,
    filter: state.filter,
    query: state.query,
    serverTotal: data.serverTotal,
    matchTotal: data.matchTotal,
    pageRowCount: data.pageRows.length,
  });

  return {
    canMutate,
    canAdmin,
    state,
    view,
    data,
    selection,
    saved,
    mutations,
    live,
    deepLinks,
    exporter,
    keyboard,
    subtitle,
    recentSearchScope,
    added30d,
    unsubbed30d,
    openCreate,
    openImport,
    closeImport,
    toggleSort,
    changeFilter,
    toggleArchived,
    resetView,
    updateVisibleColumns,
    completeBulkAction,
    reloadAfterSubscriberMutation,
  };
}

export type SubscribersPageController = ReturnType<
  typeof useSubscribersPageController
>;
