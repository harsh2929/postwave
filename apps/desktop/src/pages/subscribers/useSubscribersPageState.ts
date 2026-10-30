import { useCallback, useEffect, useRef, useState } from "react";

import type { SubscriberFilter } from "../../components/subscribers/SubscribersBrowsePanel";
import type { Subscriber } from "../../lib/api-client";
import {
  getDesktopRoute,
  navigateDesktopRoute,
  requestDesktopRouteNavigation,
  useDesktopRoute,
} from "../../lib/desktop-router";
import { type SortOrder } from "../subscribers-paging";
import {
  isCanonicalSubscribersRouteView,
  routeWithSubscribersView,
  type SubscribersRouteView,
  subscribersRouteSourceSignature,
  subscribersRouteView,
  subscribersRouteViewSignature,
} from "./subscribers-route-state";

export function useSubscribersPageState() {
  const desktopRoute = useDesktopRoute();
  const initialRouteViewRef = useRef(subscribersRouteView(desktopRoute));
  const [query, setQuery] = useState(initialRouteViewRef.current.query);
  const [filter, setFilter] = useState<SubscriberFilter>(
    initialRouteViewRef.current.filter,
  );
  const [showArchived, setShowArchived] = useState(
    initialRouteViewRef.current.showArchived,
  );
  const [page, setPage] = useState(initialRouteViewRef.current.page);
  const [sortColumn, setSortColumn] = useState<string>(
    initialRouteViewRef.current.sortColumn,
  );
  const [sortOrder, setSortOrder] = useState<SortOrder>(
    initialRouteViewRef.current.sortOrder,
  );
  const [activeSavedSegmentId, setActiveSavedSegmentId] = useState<
    string | null
  >(initialRouteViewRef.current.savedSegmentId);
  const [debouncedQuery, setDebouncedQuery] = useState(
    initialRouteViewRef.current.query,
  );
  const [selected, setSelected] = useState<Subscriber | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusedRowIndex, setFocusedRowIndex] = useState(-1);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [dedupeOpen, setDedupeOpen] = useState(false);
  const [mergeFieldsOpen, setMergeFieldsOpen] = useState(false);
  const observedRouteSignatureRef = useRef(
    subscribersRouteViewSignature(initialRouteViewRef.current),
  );
  const applyingRouteRef = useRef(false);
  const acceptedLocalSignatureRef = useRef<string | null>(null);
  const localNavigationAttemptRef = useRef(0);

  const applyRouteView = useCallback((next: SubscribersRouteView): void => {
    setQuery(next.query);
    setDebouncedQuery(next.query);
    setFilter(next.filter);
    setShowArchived(next.showArchived);
    setPage(next.page);
    setSortColumn(next.sortColumn);
    setSortOrder(next.sortOrder);
    setActiveSavedSegmentId(next.savedSegmentId);
    setSelectedKeys(new Set());
  }, []);

  const requestViewChange = useCallback(
    async (
      update:
        | SubscribersRouteView
        | ((current: SubscribersRouteView) => SubscribersRouteView),
    ) => {
      const currentRoute = getDesktopRoute();
      const currentView = subscribersRouteView(currentRoute);
      const next = typeof update === "function" ? update(currentView) : update;
      const target = routeWithSubscribersView(currentRoute, next);
      const targetView = subscribersRouteView(target);
      const targetSignature = subscribersRouteViewSignature(targetView);
      const attempt = ++localNavigationAttemptRef.current;
      const result = await requestDesktopRouteNavigation(target, {
        replace: true,
        source: "navigation",
      });
      if (attempt !== localNavigationAttemptRef.current) return result;
      if (result === "proceeded") {
        // Apply only after the lifecycle owner accepted the route. The router
        // normally emits synchronously; this also keeps isolated controllers
        // deterministic when their route subscription is intentionally mocked.
        observedRouteSignatureRef.current = targetSignature;
        acceptedLocalSignatureRef.current = targetSignature;
        applyRouteView(targetView);
      }
      return result;
    },
    [applyRouteView],
  );

  const routeView = subscribersRouteView(desktopRoute);
  const routeSignature = subscribersRouteViewSignature(routeView);
  const routeSourceSignature = subscribersRouteSourceSignature(desktopRoute);
  useEffect(() => {
    if (!isCanonicalSubscribersRouteView(desktopRoute)) {
      navigateDesktopRoute(routeWithSubscribersView(desktopRoute, routeView), {
        replace: true,
        source: "navigation",
      });
      return;
    }
    if (routeSignature === observedRouteSignatureRef.current) return;
    observedRouteSignatureRef.current = routeSignature;
    applyingRouteRef.current = true;
    applyRouteView(routeView);
  }, [applyRouteView, routeSourceSignature]);

  const localRouteView = {
    query: debouncedQuery,
    filter,
    showArchived,
    page,
    sortColumn,
    sortOrder,
    savedSegmentId: activeSavedSegmentId,
  };
  const localRouteSignature = subscribersRouteViewSignature(localRouteView);
  useEffect(() => {
    if (applyingRouteRef.current) {
      applyingRouteRef.current = false;
      return;
    }
    if (acceptedLocalSignatureRef.current === localRouteSignature) {
      acceptedLocalSignatureRef.current = null;
      return;
    }
    if (localRouteSignature === routeSignature) return;
    const attempt = ++localNavigationAttemptRef.current;
    const originRouteView = subscribersRouteView(desktopRoute);
    void requestDesktopRouteNavigation(
      routeWithSubscribersView(desktopRoute, localRouteView),
      {
        replace: true,
        source: "navigation",
      },
    ).then((result) => {
      if (attempt !== localNavigationAttemptRef.current) return;
      if (result === "proceeded") {
        acceptedLocalSignatureRef.current = localRouteSignature;
        return;
      }
      // A cancelled/busy transition must not leave an applied-looking filter
      // or page that disagrees with the canonical route. Rolling back makes
      // the same action immediately retryable.
      applyingRouteRef.current = true;
      applyRouteView(originRouteView);
    });
  }, [applyRouteView, desktopRoute, localRouteSignature, routeSignature]);

  return {
    query,
    setQuery,
    filter,
    setFilter,
    showArchived,
    setShowArchived,
    page,
    setPage,
    sortColumn,
    setSortColumn,
    sortOrder,
    setSortOrder,
    activeSavedSegmentId,
    setActiveSavedSegmentId,
    debouncedQuery,
    setDebouncedQuery,
    selected,
    setSelected,
    selectedKeys,
    setSelectedKeys,
    focusId,
    setFocusId,
    focusedRowIndex,
    setFocusedRowIndex,
    createOpen,
    setCreateOpen,
    importOpen,
    setImportOpen,
    dedupeOpen,
    setDedupeOpen,
    mergeFieldsOpen,
    setMergeFieldsOpen,
    requestViewChange,
  };
}

export type SubscribersPageState = ReturnType<typeof useSubscribersPageState>;
