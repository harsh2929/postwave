/**
 * lib/badgeCount.ts — pure helpers for the app-icon badge (NATIVE#11).
 *
 * `setNotificationHandler` has always declared `shouldSetBadge: true`, but the
 * server's Expo envelope carries no `badge` field and NOTHING in the app ever
 * called `setBadgeCountAsync` — so the icon never showed a count and never
 * cleared one, while `GET /api/v1/notifications` was already returning the
 * exact number the inbox screen fetched and discarded.
 *
 * Kept separate from lib/appBadge.ts (which reaches expo-notifications and the
 * network) so the clamping rules are unit-testable in the node environment.
 */

/**
 * Badges are an ambient signal, not a metric. iOS renders arbitrarily large
 * integers as a wide, unreadable pill, so cap the displayed number.
 */
export const MAX_APP_BADGE_COUNT = 999;

/**
 * Coerce anything the wire might hand us into a renderable badge count.
 * Non-numeric, negative, fractional, and absurd values collapse to a safe
 * integer rather than throwing inside a notification callback.
 */
export function boundedBadgeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return Math.min(MAX_APP_BADGE_COUNT, Math.floor(value));
}

/**
 * Read `unread_count` out of a notification-feed response. Returns null (not
 * 0) when the payload is not a feed, so a malformed response leaves the badge
 * untouched instead of silently clearing a real count.
 */
export function badgeCountFromFeed(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const feed = payload as Record<string, unknown>;
  if (typeof feed.unread_count !== "number") return null;
  return boundedBadgeCount(feed.unread_count);
}
