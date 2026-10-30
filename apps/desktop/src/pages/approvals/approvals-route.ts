import type {
  DesktopRoute,
  DesktopRouteFilter,
  DesktopRouteSort,
} from "../../lib/desktop-router";

export const APPROVAL_DETAIL_OVERLAY = "approval-detail";
export const APPROVAL_WORKSPACE_TABS = [
  "pending",
  "history",
  "governance",
] as const;

export type ApprovalWorkspaceTab = (typeof APPROVAL_WORKSPACE_TABS)[number];
export type ApprovalHistoryStatus =
  | "all"
  | "approved"
  | "rejected"
  | "expired"
  | "unverified";
export type ApprovalSort =
  | "newest"
  | "oldest"
  | "resource"
  | "requester"
  | "status";

export interface ApprovalRouteView {
  tab: ApprovalWorkspaceTab;
  query: string;
  status: ApprovalHistoryStatus;
  sort: ApprovalSort;
}

const APPROVAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const MAX_QUERY_CHARACTERS = 120;
const HISTORY_STATUSES = new Set<ApprovalHistoryStatus>([
  "all",
  "approved",
  "rejected",
  "expired",
  "unverified",
]);

const DEFAULT_VIEW: ApprovalRouteView = {
  tab: "pending",
  query: "",
  status: "all",
  sort: "newest",
};

function normalizedQuery(value: string | undefined): string {
  return Array.from((value ?? "").replace(/\s+/gu, " ").trim())
    .slice(0, MAX_QUERY_CHARACTERS)
    .join("")
    .trim();
}

function normalizedTab(value: string | undefined): ApprovalWorkspaceTab {
  return APPROVAL_WORKSPACE_TABS.includes(value as ApprovalWorkspaceTab)
    ? (value as ApprovalWorkspaceTab)
    : "pending";
}

function normalizedStatus(
  filters: readonly DesktopRouteFilter[] | undefined,
): ApprovalHistoryStatus {
  const value = filters?.find((filter) => filter.key === "status")?.value;
  return value && HISTORY_STATUSES.has(value as ApprovalHistoryStatus)
    ? (value as ApprovalHistoryStatus)
    : "all";
}

function normalizedSort(sort: DesktopRouteSort | undefined): ApprovalSort {
  if (!sort) return "newest";
  if (sort.field === "requested" && sort.direction === "asc") return "oldest";
  if (sort.field === "resource" && sort.direction === "asc") {
    return "resource";
  }
  if (sort.field === "requester" && sort.direction === "asc") {
    return "requester";
  }
  if (sort.field === "status" && sort.direction === "asc") return "status";
  return "newest";
}

function encodedSort(sort: ApprovalSort): DesktopRouteSort | undefined {
  switch (sort) {
    case "oldest":
      return { field: "requested", direction: "asc" };
    case "resource":
      return { field: "resource", direction: "asc" };
    case "requester":
      return { field: "requester", direction: "asc" };
    case "status":
      return { field: "status", direction: "asc" };
    default:
      return undefined;
  }
}

export function approvalRouteViewFromRoute(
  route: DesktopRoute,
): ApprovalRouteView {
  if (route.section !== "approvals") return { ...DEFAULT_VIEW };
  const tab = normalizedTab(route.tab);
  const candidateSort = normalizedSort(route.sort);
  return {
    tab,
    query: normalizedQuery(route.query),
    status: tab === "history" ? normalizedStatus(route.filters) : "all",
    sort:
      tab === "pending" && candidateSort === "status"
        ? "newest"
        : candidateSort,
  };
}

export function normalizedApprovalId(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !APPROVAL_ID_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

export function approvalDetailRouteId(route: DesktopRoute): string | null {
  if (route.section !== "approvals") return null;
  if (route.overlay?.name === APPROVAL_DETAIL_OVERLAY) {
    return normalizedApprovalId(route.overlay.resourceId);
  }
  return normalizedApprovalId(route.resourceId);
}

export function routeWithApprovalView(
  route: DesktopRoute,
  update: Partial<Pick<ApprovalRouteView, "query" | "status" | "sort">>,
): DesktopRoute {
  const current = approvalRouteViewFromRoute(route);
  const query = normalizedQuery(update.query ?? current.query);
  const status = HISTORY_STATUSES.has(update.status ?? current.status)
    ? (update.status ?? current.status)
    : "all";
  const sort = update.sort ?? current.sort;
  const base: DesktopRoute =
    route.section === "approvals" ? { ...route } : { section: "approvals" };
  const filters =
    status === "all" ? undefined : [{ key: "status", value: status }];
  return {
    ...base,
    ...(query ? { query } : { query: undefined }),
    ...(encodedSort(sort) ? { sort: encodedSort(sort) } : { sort: undefined }),
    ...(filters ? { filters } : { filters: undefined }),
  };
}

export function routeWithApprovalDetail(
  route: DesktopRoute,
  approvalId: string,
): DesktopRoute | null {
  const id = normalizedApprovalId(approvalId);
  if (!id) return null;
  const base: DesktopRoute =
    route.section === "approvals" ? { ...route } : { section: "approvals" };
  delete base.resourceId;
  return {
    ...base,
    overlay: { name: APPROVAL_DETAIL_OVERLAY, resourceId: id },
  };
}

export function routeWithoutApprovalDetail(route: DesktopRoute): DesktopRoute {
  if (route.section !== "approvals") return route;
  const next: DesktopRoute = { ...route };
  delete next.resourceId;
  if (next.overlay?.name === APPROVAL_DETAIL_OVERLAY) delete next.overlay;
  return next;
}
