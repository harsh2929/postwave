import { useEffect, useMemo, useRef, useState } from "react";

import {
  GROUP_FILTER_ALL,
  GROUP_FILTER_UNGROUPED,
} from "../../components/tags/TagGroupSidebar";
import { useCanAdmin, useCanWrite } from "../../lib/store";
import {
  TAG_PAGE_SIZE,
  TAG_DELETE_UNAVAILABLE_REASON,
  TAG_GROUPS_UNAVAILABLE_REASON,
  TAG_MERGE_UNAVAILABLE_REASON,
  buildTagDisplayList,
  countOrphanTags,
  filterTags,
  sortTagDisplayRows,
} from "./tagPageModel";
import { tagViewScopeKey } from "./tagRouteState";
import { useTagCatalog } from "./useTagCatalog";
import { useTagCreate } from "./useTagCreate";
import { useTagDelete } from "./useTagDelete";
import { useTagDetailRoute } from "./useTagDetailRoute";
import { useTagEdit } from "./useTagEdit";
import { useTagRouteView } from "./useTagRouteView";

export function useTagsPageController() {
  const canMutate = useCanWrite();
  const canAdmin = useCanAdmin();
  const catalog = useTagCatalog();
  const routeView = useTagRouteView();
  const create = useTagCreate({
    load: catalog.load,
    reloadTaxonomy: catalog.reloadTaxonomy,
  });
  const edit = useTagEdit({
    load: catalog.load,
    reloadTaxonomy: catalog.reloadTaxonomy,
  });
  const deletion = useTagDelete({
    rows: catalog.rows,
    load: catalog.load,
    reloadTaxonomy: catalog.reloadTaxonomy,
  });

  const query = routeView.view.query;
  const colorFilter = routeView.view.color;
  const page = routeView.view.page;
  const groupFilter = routeView.view.group || GROUP_FILTER_ALL;
  const groupFeatureAvailable = catalog.groupStatus.lastVerifiedAt !== null;
  const [groupManageOpen, setGroupManageOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeFromNames, setMergeFromNames] = useState<string[]>([]);
  const [registerTarget, setRegisterTarget] = useState<string | null>(null);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkEditMode, setBulkEditMode] = useState<"color" | "description">(
    "color",
  );

  const filtered = useMemo(
    () => filterTags(catalog.rows, query, colorFilter, groupFilter),
    [catalog.rows, query, colorFilter, groupFilter],
  );
  const displayList = useMemo(
    () =>
      sortTagDisplayRows(
        buildTagDisplayList(
          filtered,
          catalog.usageByName,
          query,
          colorFilter,
          groupFilter,
        ),
        routeView.view.sortField,
        routeView.view.sortDirection,
      ),
    [
      filtered,
      catalog.usageByName,
      query,
      colorFilter,
      groupFilter,
      routeView.view.sortDirection,
      routeView.view.sortField,
    ],
  );
  const totalPages = Math.max(1, Math.ceil(displayList.length / TAG_PAGE_SIZE));
  const pageRows = displayList.slice(
    (page - 1) * TAG_PAGE_SIZE,
    page * TAG_PAGE_SIZE,
  );

  useEffect(() => {
    if (page > totalPages) routeView.setPage(1);
  }, [page, routeView.setPage, totalPages]);

  useEffect(() => {
    if (
      !groupFeatureAvailable ||
      !groupFilter ||
      groupFilter === GROUP_FILTER_UNGROUPED ||
      catalog.groups.some((group) => group.id === groupFilter)
    ) {
      return;
    }
    routeView.setGroup(GROUP_FILTER_ALL);
  }, [catalog.groups, groupFeatureAvailable, groupFilter, routeView.setGroup]);

  const selectionScope = tagViewScopeKey(routeView.view);
  const previousSelectionScopeRef = useRef(selectionScope);
  useEffect(() => {
    if (previousSelectionScopeRef.current === selectionScope) return;
    previousSelectionScopeRef.current = selectionScope;
    deletion.setSelected(new Set());
    setBulkEditOpen(false);
  }, [deletion.setSelected, selectionScope]);

  useEffect(() => {
    if (!catalog.rows) return;
    const validIds = new Set(catalog.rows.map((tag) => tag.id));
    deletion.setSelected((previous) => {
      const next = new Set(
        Array.from(previous).filter((id) => validIds.has(id)),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [catalog.rows, deletion.setSelected]);

  const detailRoute = useTagDetailRoute({
    rows: catalog.rows,
    loading: catalog.loading,
    detailTag: catalog.detailTag,
    setDetailTag: catalog.setDetailTag,
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (
        event.key !== "Escape" ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }
      if (
        create.open ||
        edit.target ||
        deletion.target ||
        mergeOpen ||
        catalog.detailTag ||
        registerTarget ||
        bulkEditOpen
      ) {
        return;
      }
      if (deletion.selected.size > 0) deletion.setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    create.open,
    edit.target,
    deletion.target,
    deletion.selected,
    mergeOpen,
    catalog.detailTag,
    registerTarget,
    bulkEditOpen,
  ]);

  const orphanCount = useMemo(
    () => countOrphanTags(catalog.rows, catalog.usageByName),
    [catalog.rows, catalog.usageByName],
  );
  const usageAvailable = catalog.taxonomyStatus.lastVerifiedAt !== null;
  const visibleOrphanCount = displayList.filter(
    (row) => row.kind === "orphan",
  ).length;
  const rangeStart =
    displayList.length === 0 ? 0 : (page - 1) * TAG_PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * TAG_PAGE_SIZE, displayList.length);
  const totalLabel =
    catalog.rows !== null
      ? `${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()} of ${displayList.length.toLocaleString()} result${displayList.length === 1 ? "" : "s"} · ${catalog.rows.length.toLocaleString()} registered${usageAvailable ? ` · ${orphanCount.toLocaleString()} orphan${orphanCount === 1 ? "" : "s"}` : " · usage unavailable"}`
      : catalog.loading
        ? "Loading…"
        : "Tag catalogue unavailable";
  const writeUnavailableReason = !canMutate
    ? "Your current role has view-only access to tags. Ask an owner or admin for edit access to create, register, merge, edit, or delete tags."
    : null;
  const mergeUnavailableReason = TAG_MERGE_UNAVAILABLE_REASON;
  const mergeDescriptionId = writeUnavailableReason
    ? "tags-write-availability"
    : mergeUnavailableReason
      ? "tags-merge-availability"
      : undefined;

  const changeQuery = (value: string): void => {
    routeView.setQuery(value);
  };
  const changeColorFilter = (value: string): void => {
    routeView.setColor(value);
  };
  const changeGroupFilter = (value: string): void => {
    routeView.setGroup(value);
  };
  const openMerge = (fromNames: string[]): void => {
    setMergeFromNames(fromNames);
    setMergeOpen(true);
  };

  return {
    canMutate,
    canAdmin,
    catalog,
    create,
    edit,
    deletion,
    query,
    colorFilter,
    page,
    setPage: routeView.setPage,
    sortField: routeView.view.sortField,
    sortDirection: routeView.view.sortDirection,
    setSort: routeView.setSort,
    resetView: routeView.reset,
    groupFilter,
    groupManageOpen,
    setGroupManageOpen,
    mergeOpen,
    setMergeOpen,
    mergeFromNames,
    openMerge,
    registerTarget,
    setRegisterTarget,
    bulkEditOpen,
    setBulkEditOpen,
    bulkEditMode,
    setBulkEditMode,
    filtered,
    pageRows,
    resultCount: displayList.length,
    totalPages,
    orphanCount,
    visibleOrphanCount,
    usageAvailable,
    selectionScope,
    totalLabel,
    writeUnavailableReason,
    mergeUnavailableReason,
    mergeDescriptionId,
    groupFeatureAvailable,
    groupUnavailableReason: groupFeatureAvailable
      ? null
      : TAG_GROUPS_UNAVAILABLE_REASON,
    deleteUnavailableReason: TAG_DELETE_UNAVAILABLE_REASON,
    detailRoute,
    changeQuery,
    changeColorFilter,
    changeGroupFilter,
  };
}

export type TagsPageController = ReturnType<typeof useTagsPageController>;
