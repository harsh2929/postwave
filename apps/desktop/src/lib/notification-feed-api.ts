/**
 * notification-feed-api — desktop's client for the server notification feed.
 *
 * Mirrors `apps/web/src/lib/notification-feed-api.ts` endpoint-for-endpoint so
 * the three clients cannot drift on what the bell means. The difference is the
 * result shape: desktop's `apiRequest` RESOLVES with `{ error }` rather than
 * throwing, so a straight port of web's `try/catch` would treat every failure
 * as a success and render an empty inbox that looks like "all caught up".
 *
 * Reads therefore return a discriminated result and let the caller decide;
 * writes report a boolean so an optimistic update can roll back.
 */

import { apiRequest } from "./api-client";
import type { ServerFeedItem } from "./notification-feed-reconcile";

/** The server clamps `limit`; ask for a full page rather than a short window. */
export const NOTIFICATION_FEED_LIMIT = 50;

export interface ServerFeedResponse {
  items: ServerFeedItem[];
  unread_count: number;
}

export type FeedReadResult =
  | { ok: true; feed: ServerFeedResponse }
  | { ok: false; status: number; code: string };

function isFeedItem(value: unknown): value is ServerFeedItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.kind === "string" &&
    typeof item.title === "string" &&
    typeof item.created_at === "string"
  );
}

/**
 * Read the feed.
 *
 * Malformed rows are DROPPED rather than rendered: the bell shows server-issued
 * text, so a row missing an id or a timestamp cannot be acted on or ordered,
 * and passing it through would surface a blank entry the user cannot dismiss.
 */
export async function fetchNotificationFeed(
  limit = NOTIFICATION_FEED_LIMIT,
): Promise<FeedReadResult> {
  const result = await apiRequest<ServerFeedResponse>(
    `/api/v1/notifications?limit=${encodeURIComponent(String(limit))}`,
  );
  if (result.error) {
    return {
      ok: false,
      status: result.error.status ?? 0,
      code: result.error.code ?? "unknown_error",
    };
  }
  const data = result.data as ServerFeedResponse | undefined;
  const items = Array.isArray(data?.items) ? data.items.filter(isFeedItem) : [];
  return {
    ok: true,
    feed: {
      items,
      unread_count:
        typeof data?.unread_count === "number" ? data.unread_count : 0,
    },
  };
}

async function post(path: string): Promise<boolean> {
  const result = await apiRequest(path, { method: "POST" });
  return !result.error;
}

/** Clear the unseen badge. */
export const markFeedSeen = (): Promise<boolean> =>
  post("/api/v1/notifications/seen");

/** Mark every notification read, on every device. */
export const markFeedAllRead = (): Promise<boolean> =>
  post("/api/v1/notifications/read-all");

/** Mark one notification read, on every device. */
export const markFeedRead = (id: string): Promise<boolean> =>
  post(`/api/v1/notifications/${encodeURIComponent(id)}/read`);
