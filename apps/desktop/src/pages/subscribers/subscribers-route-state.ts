import {
  UI_STATUSES,
  type SubscriberUiStatus,
} from "../../components/subscribers/subscriber-status";
import type { SubscriberFilter } from "../../components/subscribers/SubscribersBrowsePanel";
import type { DesktopRoute } from "../../lib/desktop-router";
import {
  DEFAULT_ORDER,
  DEFAULT_SORT,
  type SortOrder,
} from "../subscribers-paging";

const OWNED_FILTER_KEYS = new Set(["archived", "page", "saved-view", "status"]);
const ROUTE_SORT_COLUMNS = new Set([
  "updated_at",
  "created_at",
  "email",
  "status",
  "engagement",
  "first_name",
  "last_name",
  "churn",
  "rating",
  "joined",
  "churn_score",
  "full_name",
  "display_name",
]);
const MAX_ROUTE_QUERY_CHARS = 256;
const MAX_ROUTE_PAGE = 1_000_000;
const SAVED_VIEW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;

export interface SubscribersRouteView {
  query: string;
  filter: SubscriberFilter;
  showArchived: boolean;
  page: number;
  sortColumn: string;
  sortOrder: SortOrder;
  savedSegmentId: string | null;
}

function filterValue(route: DesktopRoute, key: string): string | undefined {
  return route.filters?.find((filter) => filter.key === key)?.value;
}

function routeFilter(value: string | undefined): SubscriberFilter {
  if (!value || value === "all") return "all";
  return (UI_STATUSES as readonly string[]).includes(value)
    ? (value as SubscriberUiStatus)
    : "all";
}

function routePage(value: string | undefined): number {
  if (!value || !/^\d{1,7}$/u.test(value)) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_ROUTE_PAGE
    ? parsed
    : 1;
}

function decodeSortColumn(value: string | undefined): string {
  if (!value) return DEFAULT_SORT;
  const decoded = value.replaceAll("-", "_");
  return ROUTE_SORT_COLUMNS.has(decoded) ? decoded : DEFAULT_SORT;
}

function hasSupportedRouteSort(value: string | undefined): boolean {
  return (
    value === undefined || ROUTE_SORT_COLUMNS.has(value.replaceAll("-", "_"))
  );
}

function encodeSortColumn(value: string): string {
  const supported = ROUTE_SORT_COLUMNS.has(value) ? value : DEFAULT_SORT;
  return supported.replaceAll("_", "-");
}

function normalizedQuery(value: string): string {
  return value.trim().slice(0, MAX_ROUTE_QUERY_CHARS);
}

function savedSegmentId(value: string | undefined): string | null {
  return value && SAVED_VIEW_ID_RE.test(value) ? value : null;
}

export function subscribersRouteView(
  route: DesktopRoute,
): SubscribersRouteView {
  return {
    query: route.section === "subscribers" ? (route.query ?? "") : "",
    filter:
      route.section === "subscribers"
        ? routeFilter(filterValue(route, "status"))
        : "all",
    showArchived:
      route.section === "subscribers" &&
      filterValue(route, "archived") === "true",
    page:
      route.section === "subscribers"
        ? routePage(filterValue(route, "page"))
        : 1,
    sortColumn:
      route.section === "subscribers"
        ? decodeSortColumn(route.sort?.field)
        : DEFAULT_SORT,
    sortOrder:
      route.section === "subscribers" &&
      hasSupportedRouteSort(route.sort?.field)
        ? (route.sort?.direction ?? DEFAULT_ORDER)
        : DEFAULT_ORDER,
    savedSegmentId:
      route.section === "subscribers"
        ? savedSegmentId(filterValue(route, "saved-view"))
        : null,
  };
}

export function subscribersRouteViewSignature(
  view: SubscribersRouteView,
): string {
  return JSON.stringify([
    normalizedQuery(view.query),
    view.filter,
    view.showArchived,
    Math.max(1, Math.min(MAX_ROUTE_PAGE, Math.floor(view.page) || 1)),
    ROUTE_SORT_COLUMNS.has(view.sortColumn) ? view.sortColumn : DEFAULT_SORT,
    view.sortOrder === "asc" ? "asc" : "desc",
    view.savedSegmentId && SAVED_VIEW_ID_RE.test(view.savedSegmentId)
      ? view.savedSegmentId
      : null,
  ]);
}

export function subscribersRouteSourceSignature(route: DesktopRoute): string {
  return JSON.stringify([
    route.section,
    route.query ?? "",
    route.sort?.field ?? "",
    route.sort?.direction ?? "",
    filterValue(route, "status") ?? "",
    filterValue(route, "archived") ?? "",
    filterValue(route, "page") ?? "",
    filterValue(route, "saved-view") ?? "",
  ]);
}

export function routeWithSubscribersView(
  route: DesktopRoute,
  view: SubscribersRouteView,
): DesktopRoute {
  const query = normalizedQuery(view.query);
  const page = Math.max(
    1,
    Math.min(MAX_ROUTE_PAGE, Math.floor(view.page) || 1),
  );
  const sortColumn = ROUTE_SORT_COLUMNS.has(view.sortColumn)
    ? view.sortColumn
    : DEFAULT_SORT;
  const sortOrder = view.sortOrder === "asc" ? "asc" : "desc";
  const preservedFilters = (route.filters ?? []).filter(
    ({ key }) => !OWNED_FILTER_KEYS.has(key),
  );
  const filters = [
    ...preservedFilters,
    ...(view.filter === "all" ? [] : [{ key: "status", value: view.filter }]),
    ...(view.showArchived ? [{ key: "archived", value: "true" }] : []),
    ...(page === 1 ? [] : [{ key: "page", value: String(page) }]),
    ...(view.savedSegmentId && SAVED_VIEW_ID_RE.test(view.savedSegmentId)
      ? [{ key: "saved-view", value: view.savedSegmentId }]
      : []),
  ];
  const isDefaultSort =
    sortColumn === DEFAULT_SORT && sortOrder === DEFAULT_ORDER;
  return {
    ...route,
    section: "subscribers",
    query: query || undefined,
    sort: isDefaultSort
      ? undefined
      : { field: encodeSortColumn(sortColumn), direction: sortOrder },
    filters: filters.length > 0 ? filters : undefined,
  };
}

export function isCanonicalSubscribersRouteView(route: DesktopRoute): boolean {
  if (route.section !== "subscribers") return true;
  const canonical = routeWithSubscribersView(
    route,
    subscribersRouteView(route),
  );
  return (
    subscribersRouteSourceSignature(route) ===
    subscribersRouteSourceSignature(canonical)
  );
}
