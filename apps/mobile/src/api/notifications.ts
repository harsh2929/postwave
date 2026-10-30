/**
 * api/notifications.ts — the in-app notification feed (the "bell"), reading the
 * same GET /api/v1/notifications the web bell uses. The feed query key root is
 * `notification-feed`, which the realtime cache-invalidation layer maps from the
 * server's `notification.created` fanout event, so the bell stays live.
 *
 * Two corrections over the first pass:
 *
 *  - It no longer swallows errors into an empty feed. `EMPTY on error` made a
 *    500 or an expired session render as "You're all caught up." — the same
 *    class of lie search made. The read throws so TanStack can mark the query
 *    errored and the screen can say what happened.
 *  - The default limit is no longer 30. The server clamps `limit` to 200 and has
 *    NO cursor (Repo.List takes only unreadOnly + limit), so a user returning
 *    from a week off saw a 30-item window of a 200-item backlog and then
 *    "Mark all read" cleared items they never saw. Real pagination needs a
 *    backend change; asking for the server's maximum is the fix available today.
 */
import { checkedApiResult, rawRequest } from "./request";

export interface MobileNotification {
  id: string;
  kind: string;
  /**
   * The event the fanout dispatched under (`Item.EventType`, omitempty).
   *
   * NOT the same field as `kind`, and the difference is load-bearing: the
   * fanout falls back to `ev.Type` for `kind` only when a producer left `Kind`
   * empty (notifyfanout/fanout.go:212-214), so the two coincide for some rows
   * and not others. The server has always sent this; the client type simply
   * omitted it, so the inbox could only ever route by the field that sometimes
   * happened to agree.
   */
  event_type?: string;
  title: string;
  body?: string;
  deep_link?: string;
  /** `Item.Payload` — entity ids and counts. Never customer PII. */
  payload?: Record<string, unknown>;
  seen_at?: string;
  read_at?: string;
  created_at: string;
}

export interface NotificationFeed {
  items: MobileNotification[];
  unread_count: number;
}

/** The server's clamp. Asking for more is silently reduced to 50, not 200. */
export const NOTIFICATION_FEED_LIMIT = 200;

export interface NotificationFeedQuery {
  limit?: number;
  /** Server-side filter — `?unread=true` is already supported by List. */
  unreadOnly?: boolean;
}

/**
 * The tenant-scoped notification feed. THROWS on failure so the caller's query
 * enters its error state instead of rendering a fabricated empty inbox.
 */
export async function fetchNotificationFeed(
  query: NotificationFeedQuery = {},
): Promise<NotificationFeed> {
  const limit = query.limit ?? NOTIFICATION_FEED_LIMIT;
  const params = new URLSearchParams({ limit: String(limit) });
  if (query.unreadOnly) params.set("unread", "true");
  const res = await checkedApiResult(
    rawRequest<NotificationFeed>(
      "GET",
      `/api/v1/notifications?${params.toString()}`,
    ),
  );
  const data = res.data;
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    unread_count:
      typeof data?.unread_count === "number" ? data.unread_count : 0,
  };
}

/** Mark the whole feed seen (clears the unseen badge). Throws on failure. */
export async function markNotificationsSeen(): Promise<void> {
  await checkedApiResult(rawRequest("POST", "/api/v1/notifications/seen"));
}

/** Mark every notification read. Throws on failure. */
export async function markAllNotificationsRead(): Promise<void> {
  await checkedApiResult(rawRequest("POST", "/api/v1/notifications/read-all"));
}

/** Mark one notification read. Throws so an optimistic update can roll back. */
export async function markNotificationRead(id: string): Promise<void> {
  await checkedApiResult(
    rawRequest("POST", `/api/v1/notifications/${encodeURIComponent(id)}/read`),
  );
}

/**
 * Apply a read receipt to a cached feed.
 *
 * Pure so the optimistic path is testable: tapping a row used to cost a POST
 * plus a full refetch before the blue dot cleared, and on a slow connection the
 * dot lingered after the screen had already navigated away.
 */
export function markFeedItemRead(
  feed: NotificationFeed | undefined,
  id: string,
  now: string,
): NotificationFeed | undefined {
  if (!feed) return feed;
  let changed = false;
  const items = feed.items.map((item) => {
    if (item.id !== id || item.read_at) return item;
    changed = true;
    return { ...item, read_at: now, seen_at: item.seen_at ?? now };
  });
  if (!changed) return feed;
  return {
    items,
    unread_count: Math.max(0, feed.unread_count - 1),
  };
}

/** Apply "mark all read" to a cached feed. */
export function markFeedAllRead(
  feed: NotificationFeed | undefined,
  now: string,
): NotificationFeed | undefined {
  if (!feed) return feed;
  return {
    items: feed.items.map((item) =>
      item.read_at ? item : { ...item, read_at: now, seen_at: item.seen_at ?? now },
    ),
    unread_count: 0,
  };
}

/**
 * Stamp `seen_at` locally instead of invalidating the whole feed.
 *
 * Opening the inbox used to cost GET(rows) → POST /seen → GET(rows again), and
 * the second GET re-rendered the list under the user's thumb. `seen_at` is not
 * rendered anywhere, so there is nothing a refetch could reveal.
 */
export function markFeedSeen(
  feed: NotificationFeed | undefined,
  now: string,
): NotificationFeed | undefined {
  if (!feed) return feed;
  if (feed.items.every((item) => item.seen_at)) return feed;
  return {
    ...feed,
    items: feed.items.map((item) =>
      item.seen_at ? item : { ...item, seen_at: now },
    ),
  };
}
