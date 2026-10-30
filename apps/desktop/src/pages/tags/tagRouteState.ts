import type {
  DesktopRoute,
  DesktopSortDirection,
} from "../../lib/desktop-router";

export const TAG_DETAIL_OVERLAY = "tag-detail";
export const TAG_DEFAULT_SORT_FIELD = "name";
export const TAG_DEFAULT_SORT_DIRECTION: DesktopSortDirection = "asc";

export type TagSortField = "name" | "subscribers" | "created";

export interface TagViewState {
  query: string;
  color: string;
  group: string;
  page: number;
  sortField: TagSortField;
  sortDirection: DesktopSortDirection;
}

const TAG_VIEW_FILTERS = new Set(["color", "group", "page"]);

function firstFilter(route: DesktopRoute, key: string): string | undefined {
  return route.filters?.find((filter) => filter.key === key)?.value;
}

function validPage(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]{0,5}$/u.test(value)) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 1;
}

function validSortField(value: string | undefined): TagSortField {
  return value === "subscribers" || value === "created" ? value : "name";
}

export function tagViewFromRoute(route: DesktopRoute): TagViewState {
  if (route.section !== "tags") {
    return {
      query: "",
      color: "all",
      group: "",
      page: 1,
      sortField: TAG_DEFAULT_SORT_FIELD,
      sortDirection: TAG_DEFAULT_SORT_DIRECTION,
    };
  }
  const color = firstFilter(route, "color");
  const group = firstFilter(route, "group");
  return {
    query: route.query ?? "",
    color: color && /^[a-z][a-z0-9-]{0,31}$/u.test(color) ? color : "all",
    group:
      group && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(group) ? group : "",
    page: validPage(firstFilter(route, "page")),
    sortField: validSortField(route.sort?.field),
    sortDirection: route.sort?.direction ?? TAG_DEFAULT_SORT_DIRECTION,
  };
}

export function routeWithTagView(
  route: DesktopRoute,
  view: TagViewState,
): DesktopRoute {
  const retainedFilters =
    route.section === "tags"
      ? (route.filters ?? []).filter(
          (filter) => !TAG_VIEW_FILTERS.has(filter.key),
        )
      : [];
  const filters = [
    ...retainedFilters,
    ...(view.color === "all" ? [] : [{ key: "color", value: view.color }]),
    ...(view.group ? [{ key: "group", value: view.group }] : []),
    ...(view.page === 1 ? [] : [{ key: "page", value: String(view.page) }]),
  ];
  return {
    ...(route.section === "tags" ? route : { section: "tags" as const }),
    section: "tags",
    query: view.query.trim() ? view.query.slice(0, 256) : undefined,
    filters: filters.length > 0 ? filters : undefined,
    sort:
      view.sortField === TAG_DEFAULT_SORT_FIELD &&
      view.sortDirection === TAG_DEFAULT_SORT_DIRECTION
        ? undefined
        : { field: view.sortField, direction: view.sortDirection },
  };
}

export function tagDetailRouteId(route: DesktopRoute): string | null {
  if (route.section !== "tags") return null;
  if (route.overlay?.name === TAG_DETAIL_OVERLAY && route.overlay.resourceId) {
    return route.overlay.resourceId;
  }
  return route.resourceId ?? null;
}

export function routeWithTagDetail(
  route: DesktopRoute,
  tagId: string,
): DesktopRoute {
  const next: DesktopRoute = {
    ...(route.section === "tags" ? route : { section: "tags" }),
    section: "tags",
    overlay: { name: TAG_DETAIL_OVERLAY, resourceId: tagId },
  };
  delete next.resourceId;
  return next;
}

export function routeWithoutTagDetail(route: DesktopRoute): DesktopRoute {
  if (route.section !== "tags") return route;
  const next: DesktopRoute = { ...route };
  delete next.resourceId;
  if (next.overlay?.name === TAG_DETAIL_OVERLAY) delete next.overlay;
  return next;
}

export function tagViewScopeKey(view: TagViewState): string {
  return [
    view.query.trim().normalize("NFKC").toLocaleLowerCase(),
    view.color,
    view.group,
    String(view.page),
    view.sortField,
    view.sortDirection,
  ].join("\u0000");
}
