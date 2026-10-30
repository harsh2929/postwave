import type { DesktopRoute, DesktopRouteSort } from "../../lib/desktop-router";
import { serializeDesktopRoute } from "../../lib/desktop-router";
import { RETENTION_RECORD_CAP } from "../../lib/retention-offers-contract";
import type {
  RetentionDiscountFilter,
  RetentionEvidenceFilter,
  RetentionHistorySort,
  RetentionStatusFilter,
} from "../../lib/retention-offers-view-model";

export const RETENTION_OFFER_DETAIL_OVERLAY = "retention-offer-detail";
export const RETENTION_HISTORY_PAGE_SIZE = 20;

const MAX_QUERY_CHARACTERS = 256;
const MAX_PAGE = Math.ceil(RETENTION_RECORD_CAP / RETENTION_HISTORY_PAGE_SIZE);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const STATUS_FILTERS = new Set<RetentionStatusFilter>([
  "all",
  "active",
  "inactive",
]);
const DISCOUNT_FILTERS = new Set<RetentionDiscountFilter>([
  "all",
  "percent",
  "fixed",
]);
const EVIDENCE_FILTERS = new Set<RetentionEvidenceFilter>([
  "all",
  "measured",
  "zero",
  "unknown",
  "anomaly",
]);

export type RetentionHistoryTab = "overview" | "history" | "readiness";

export interface RetentionHistoryRouteView {
  tab: RetentionHistoryTab;
  query: string;
  status: RetentionStatusFilter;
  discount: RetentionDiscountFilter;
  evidence: RetentionEvidenceFilter;
  sort: RetentionHistorySort;
  page: number;
}

const DEFAULT_VIEW: RetentionHistoryRouteView = {
  tab: "overview",
  query: "",
  status: "all",
  discount: "all",
  evidence: "all",
  sort: "newest",
  page: 1,
};

function filterValue(route: DesktopRoute, key: string): string | undefined {
  return route.filters?.find((filter) => filter.key === key)?.value;
}

function normalizedQuery(value: string): string {
  return value.trim().slice(0, MAX_QUERY_CHARACTERS);
}

function routeTab(value: string | undefined): RetentionHistoryTab {
  return value === "history" || value === "readiness" ? value : "overview";
}

function routeStatus(value: string | undefined): RetentionStatusFilter {
  return value && STATUS_FILTERS.has(value as RetentionStatusFilter)
    ? (value as RetentionStatusFilter)
    : "all";
}

function routeDiscount(value: string | undefined): RetentionDiscountFilter {
  return value && DISCOUNT_FILTERS.has(value as RetentionDiscountFilter)
    ? (value as RetentionDiscountFilter)
    : "all";
}

function routeEvidence(value: string | undefined): RetentionEvidenceFilter {
  return value && EVIDENCE_FILTERS.has(value as RetentionEvidenceFilter)
    ? (value as RetentionEvidenceFilter)
    : "all";
}

function routePage(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]{0,2}$/u.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) && page <= MAX_PAGE ? page : 1;
}

function routeSort(sort: DesktopRouteSort | undefined): RetentionHistorySort {
  if (!sort) return "newest";
  if (sort.field === "recorded") {
    return sort.direction === "asc" ? "oldest" : "newest";
  }
  if (sort.field === "updated" && sort.direction === "desc") {
    return "updated-desc";
  }
  if (sort.field === "tier" && sort.direction === "asc") return "tier-asc";
  if (sort.field === "shown" && sort.direction === "desc") {
    return "shown-desc";
  }
  if (sort.field === "accepted" && sort.direction === "desc") {
    return "accepted-desc";
  }
  return "newest";
}

function encodedSort(sort: RetentionHistorySort): DesktopRouteSort | undefined {
  switch (sort) {
    case "oldest":
      return { field: "recorded", direction: "asc" };
    case "tier-asc":
      return { field: "tier", direction: "asc" };
    case "updated-desc":
      return { field: "updated", direction: "desc" };
    case "shown-desc":
      return { field: "shown", direction: "desc" };
    case "accepted-desc":
      return { field: "accepted", direction: "desc" };
    default:
      return undefined;
  }
}

function normalizedOfferId(value: string | undefined): string | null {
  if (!value || value !== value.trim() || !UUID_PATTERN.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

export function retentionHistoryViewFromRoute(
  route: DesktopRoute,
): RetentionHistoryRouteView {
  if (route.section !== "retentionOffers") return { ...DEFAULT_VIEW };
  return {
    tab: routeTab(route.tab),
    query: normalizedQuery(route.query ?? ""),
    status: routeStatus(filterValue(route, "status")),
    discount: routeDiscount(filterValue(route, "discount")),
    evidence: routeEvidence(filterValue(route, "evidence")),
    sort: routeSort(route.sort),
    page: routePage(filterValue(route, "page")),
  };
}

export function retentionOfferDetailRouteId(
  route: DesktopRoute,
): string | null {
  if (route.section !== "retentionOffers") return null;
  if (route.overlay?.name === RETENTION_OFFER_DETAIL_OVERLAY) {
    return normalizedOfferId(route.overlay.resourceId);
  }
  return normalizedOfferId(route.resourceId);
}

function routeFromView(
  view: RetentionHistoryRouteView,
  detailId: string | null,
): DesktopRoute {
  const page = Math.max(1, Math.min(MAX_PAGE, Math.floor(view.page) || 1));
  const query = normalizedQuery(view.query);
  const status = STATUS_FILTERS.has(view.status) ? view.status : "all";
  const discount = DISCOUNT_FILTERS.has(view.discount) ? view.discount : "all";
  const evidence = EVIDENCE_FILTERS.has(view.evidence) ? view.evidence : "all";
  const filters = [
    ...(status === "all" ? [] : [{ key: "status", value: status }]),
    ...(discount === "all" ? [] : [{ key: "discount", value: discount }]),
    ...(evidence === "all" ? [] : [{ key: "evidence", value: evidence }]),
    ...(page === 1 ? [] : [{ key: "page", value: String(page) }]),
  ];
  const requestedTab =
    view.tab === "history" || view.tab === "readiness" ? view.tab : "overview";
  const tab = detailId ? "history" : requestedTab;

  return {
    section: "retentionOffers",
    ...(tab === "overview" ? {} : { tab }),
    ...(query ? { query } : {}),
    ...(encodedSort(view.sort) ? { sort: encodedSort(view.sort) } : {}),
    ...(filters.length > 0 ? { filters } : {}),
    ...(detailId
      ? {
          overlay: {
            name: RETENTION_OFFER_DETAIL_OVERLAY,
            resourceId: detailId,
          },
        }
      : {}),
  };
}

/**
 * Build the complete supported retention route. Unlike generic list codecs,
 * this route owns every accepted filter token, so unknown filters are removed
 * rather than carried into a URL that the interface cannot explain.
 */
export function routeWithRetentionHistoryView(
  route: DesktopRoute,
  view: RetentionHistoryRouteView,
): DesktopRoute {
  return routeFromView(view, retentionOfferDetailRouteId(route));
}

export function routeWithRetentionOfferDetail(
  route: DesktopRoute,
  offerId: string,
): DesktopRoute {
  const normalizedId = normalizedOfferId(offerId);
  const view = retentionHistoryViewFromRoute(route);
  return routeFromView(view, normalizedId);
}

export function routeWithoutRetentionOfferDetail(
  route: DesktopRoute,
): DesktopRoute {
  return routeFromView(retentionHistoryViewFromRoute(route), null);
}

export function canonicalRetentionHistoryRoute(
  route: DesktopRoute,
): DesktopRoute {
  if (route.section !== "retentionOffers") {
    return { section: "retentionOffers" };
  }
  return routeFromView(
    retentionHistoryViewFromRoute(route),
    retentionOfferDetailRouteId(route),
  );
}

export function isCanonicalRetentionHistoryRoute(route: DesktopRoute): boolean {
  if (route.section !== "retentionOffers") return true;
  try {
    return (
      serializeDesktopRoute(route) ===
      serializeDesktopRoute(canonicalRetentionHistoryRoute(route))
    );
  } catch {
    return false;
  }
}
