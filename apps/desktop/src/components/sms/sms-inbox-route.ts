import type {
  SMSConversationFilter,
  SMSConversationSort,
  SMSConversationStatus,
} from "../../lib/api-client";
import type { DesktopRoute } from "../../lib/desktop-router";

export type SMSInboxMode = "inbox" | "broadcasts";

const LIFECYCLE_FILTER = "conversation-lifecycle";
const INBOX_FILTER = "conversation-filter";

export const SMS_BROADCAST_PROGRESS_OVERLAY = "sms-broadcast-progress";

const SMS_STATUSES = new Set<SMSConversationStatus>([
  "active",
  "snoozed",
  "archived",
  "any",
]);
const SMS_FILTERS = new Set<SMSConversationFilter>([
  "all",
  "unread",
  "unknown",
]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface SMSInboxRouteView {
  mode: SMSInboxMode;
  status: SMSConversationStatus;
  filter: SMSConversationFilter;
  sort: SMSConversationSort;
  broadcastProgressId: string | null;
  needsNormalization: boolean;
}

function values(route: DesktopRoute, key: string): string[] {
  return (route.filters ?? [])
    .filter((entry) => entry.key === key)
    .map((entry) => entry.value);
}

export function smsInboxRouteView(route: DesktopRoute): SMSInboxRouteView {
  if (route.section !== "smsInbox") {
    return {
      mode: "inbox",
      status: "active",
      filter: "all",
      sort: "recent",
      broadcastProgressId: null,
      needsNormalization: false,
    };
  }

  const mode: SMSInboxMode =
    route.tab === "broadcasts" ? "broadcasts" : "inbox";
  const lifecycleValues = values(route, LIFECYCLE_FILTER);
  const filterValues = values(route, INBOX_FILTER);
  const rawStatus = lifecycleValues[0];
  const rawFilter = filterValues[0];
  const status = SMS_STATUSES.has(rawStatus as SMSConversationStatus)
    ? (rawStatus as SMSConversationStatus)
    : "active";
  const filter = SMS_FILTERS.has(rawFilter as SMSConversationFilter)
    ? (rawFilter as SMSConversationFilter)
    : "all";
  const sort: SMSConversationSort =
    route.sort?.field === "unread" && route.sort.direction === "asc"
      ? "oldest_unread"
      : "recent";
  const rawProgress =
    mode === "broadcasts" &&
    route.overlay?.name === SMS_BROADCAST_PROGRESS_OVERLAY
      ? route.overlay.resourceId
      : undefined;
  const broadcastProgressId =
    rawProgress && UUID_RE.test(rawProgress) ? rawProgress : null;
  const ownedFilterCount = (route.filters ?? []).filter(
    (entry) => entry.key === LIFECYCLE_FILTER || entry.key === INBOX_FILTER,
  ).length;
  const hasUnknownFilters = (route.filters?.length ?? 0) !== ownedFilterCount;
  const sortIsCanonical =
    route.sort === undefined ||
    (route.sort.field === "unread" && route.sort.direction === "asc");

  return {
    mode,
    status,
    filter,
    sort,
    broadcastProgressId,
    needsNormalization:
      (route.tab !== undefined && route.tab !== "broadcasts") ||
      lifecycleValues.length > 1 ||
      filterValues.length > 1 ||
      (rawStatus !== undefined && status !== rawStatus) ||
      (rawFilter !== undefined && filter !== rawFilter) ||
      hasUnknownFilters ||
      !sortIsCanonical ||
      route.resourceId !== undefined ||
      route.query !== undefined ||
      (route.overlay !== undefined && broadcastProgressId === null) ||
      (mode === "broadcasts" &&
        (route.query !== undefined ||
          route.sort !== undefined ||
          (route.filters?.length ?? 0) > 0)),
  };
}

export function routeWithSMSInboxView(
  route: DesktopRoute,
  patch: Partial<Omit<SMSInboxRouteView, "needsNormalization">>,
): DesktopRoute {
  const current = smsInboxRouteView(route);
  const next = { ...current, ...patch };
  if (next.mode === "broadcasts") {
    return {
      section: "smsInbox",
      tab: "broadcasts",
      ...(next.broadcastProgressId
        ? {
            overlay: {
              name: SMS_BROADCAST_PROGRESS_OVERLAY,
              resourceId: next.broadcastProgressId,
            },
          }
        : {}),
    };
  }

  const filters = [
    ...(next.status === "active"
      ? []
      : [{ key: LIFECYCLE_FILTER, value: next.status }]),
    ...(next.filter === "all"
      ? []
      : [{ key: INBOX_FILTER, value: next.filter }]),
  ];
  return {
    section: "smsInbox",
    ...(next.sort === "oldest_unread"
      ? { sort: { field: "unread", direction: "asc" as const } }
      : {}),
    ...(filters.length > 0 ? { filters } : {}),
  };
}

export function safeSMSInboxBoundaryRoute(): DesktopRoute {
  return { section: "smsInbox" };
}
