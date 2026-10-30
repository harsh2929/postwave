import { useCallback } from "react";

import {
  getDesktopRoute,
  requestDesktopRouteNavigation,
  useDesktopRoute,
  type DesktopSortDirection,
} from "../../lib/desktop-router";
import {
  routeWithTagView,
  tagViewFromRoute,
  type TagSortField,
  type TagViewState,
} from "./tagRouteState";

export function useTagRouteView() {
  const route = useDesktopRoute();
  const view = tagViewFromRoute(route);

  const commit = useCallback(
    (
      update: (current: TagViewState) => TagViewState,
      replace = false,
    ): void => {
      const currentRoute = getDesktopRoute();
      const current = tagViewFromRoute(currentRoute);
      void requestDesktopRouteNavigation(
        routeWithTagView(currentRoute, update(current)),
        { replace, source: "navigation" },
      );
    },
    [],
  );

  const setQuery = useCallback(
    (query: string): void =>
      commit((current) => ({ ...current, query, page: 1 }), true),
    [commit],
  );
  const setColor = useCallback(
    (color: string): void =>
      commit((current) => ({ ...current, color, page: 1 })),
    [commit],
  );
  const setGroup = useCallback(
    (group: string): void =>
      commit((current) => ({ ...current, group, page: 1 })),
    [commit],
  );
  const setPage = useCallback(
    (page: number | ((current: number) => number)): void =>
      commit((current) => ({
        ...current,
        page:
          typeof page === "function"
            ? Math.max(1, page(current.page))
            : Math.max(1, page),
      })),
    [commit],
  );
  const setSort = useCallback(
    (field: TagSortField, direction: DesktopSortDirection): void =>
      commit((current) => ({
        ...current,
        sortField: field,
        sortDirection: direction,
        page: 1,
      })),
    [commit],
  );
  const reset = useCallback(
    (): void =>
      commit(
        () => ({
          query: "",
          color: "all",
          group: "",
          page: 1,
          sortField: "name",
          sortDirection: "asc",
        }),
        true,
      ),
    [commit],
  );

  return { view, setQuery, setColor, setGroup, setPage, setSort, reset };
}

export type TagRouteViewController = ReturnType<typeof useTagRouteView>;
