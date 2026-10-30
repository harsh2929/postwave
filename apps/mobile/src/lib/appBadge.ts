/**
 * lib/appBadge.ts — keeps the app-icon badge in step with the unread inbox
 * (NATIVE#11).
 *
 * Why this lives outside the notifications screen: the badge is an AMBIENT
 * signal, so it has to update when the user is NOT looking at the app. It is
 * therefore driven from the two places that learn about new notifications
 * without a screen mounted —
 *
 *   - a foreground push arriving (lib/pushLifecycle.ts), and
 *   - the realtime `notification.created` event (lib/eventCacheSync.ts →
 *     the query invalidation the inbox observes),
 *
 * — plus an explicit refresh after push registration completes.
 *
 * The read is deliberately `?limit=1`: `unread_count` is computed
 * independently of `limit` server-side (apps/api/internal/notification_feed
 * Repo.List), so a badge refresh costs one row, not a whole feed.
 */
import * as Notifications from "expo-notifications";

import { badgeCountFromFeed, boundedBadgeCount } from "./badgeCount";

let inFlight: Promise<number | null> | null = null;

async function applyBadge(count: number): Promise<void> {
  try {
    await Notifications.setBadgeCountAsync(count);
  } catch {
    // Badge support is unavailable on some Android launchers and on
    // simulators; never let it break a notification callback.
  }
}

/** Set the icon badge directly (already-known count). */
export async function setAppBadge(count: unknown): Promise<void> {
  await applyBadge(boundedBadgeCount(count));
}

/** Clear the icon badge. Call on sign-out alongside clearPushToken(). */
export async function clearAppBadge(): Promise<void> {
  await applyBadge(0);
}

/**
 * Re-read the unread count and apply it. Single-flight: several triggers can
 * fire together (a push arrives while the SSE event lands) and one round trip
 * is enough. Returns the applied count, or null when it could not be read —
 * in which case the existing badge is left alone rather than zeroed.
 */
export function refreshAppBadge(): Promise<number | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const { rawRequest } = await import("@/api/request");
      const res = await rawRequest<unknown>(
        "GET",
        "/api/v1/notifications?limit=1",
      );
      if (res.error) return null;
      const count = badgeCountFromFeed(res.data);
      if (count === null) return null;
      await applyBadge(count);
      return count;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
