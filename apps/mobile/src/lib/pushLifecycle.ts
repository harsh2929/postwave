/**
 * lib/pushLifecycle.ts — the two long-lived push listeners the app was missing.
 *
 *   - NATIVE#48: `Notifications.addPushTokenListener`. APNs/FCM can rotate a
 *     token while the app is resident. Nothing observed that, so for a
 *     long-lived session the device silently stopped receiving pushes until
 *     the next COLD launch — and server-side, receipts.go deactivates the row
 *     on `DeviceNotRegistered`, so the Settings toggle kept reading ON while
 *     delivery was dead.
 *
 *   - NATIVE#64: `addNotificationReceivedListener`. A foreground push rendered
 *     a banner with no invalidation of its own; the inbox only kept up because
 *     the SSE stream carried `notification.created` in parallel. That stream
 *     can be silently dead (NATIVE#9), producing a banner over an empty inbox.
 *
 * Started from `completePushRegistration` (lib/push.ts) rather than the root
 * layout: both listeners are only meaningful once a token exists, and that is
 * exactly the moment registration succeeds. Idempotent — registration runs on
 * every launch.
 */
import * as Notifications from "expo-notifications";

import { queryClient } from "@/lib/queryClient";
import { clearAppBadge, refreshAppBadge } from "@/lib/appBadge";
import { queryRootsForPushData } from "@/lib/pushInvalidation";

type Subscription = { remove: () => void };

let started = false;
let subscriptions: Subscription[] = [];

/** Invalidate the caches a delivered push dirties, then re-badge the icon. */
export function handleDeliveredPush(data: unknown): void {
  for (const root of queryRootsForPushData(data)) {
    void queryClient.invalidateQueries({ queryKey: [root] });
  }
  void refreshAppBadge();
}

/**
 * Install the listeners. `onTokenRotated` re-runs the registration tail with
 * the existing device key so the server rotates the row through its
 * possession-key upsert. Safe to call repeatedly.
 */
export function startPushLifecycle(options: {
  onTokenRotated: (token: string) => Promise<unknown>;
}): void {
  if (started) return;
  started = true;
  try {
    subscriptions.push(
      Notifications.addNotificationReceivedListener((notification) => {
        handleDeliveredPush(notification?.request?.content?.data);
      }),
    );
    subscriptions.push(
      Notifications.addPushTokenListener((token) => {
        const value = typeof token?.data === "string" ? token.data : "";
        if (!value) return;
        void options.onTokenRotated(value).catch(() => {
          // A failed re-registration leaves the previous row in place; the
          // next launch re-registers from scratch.
        });
      }),
    );
  } catch {
    // Listener registration is best-effort — a failure here must never break
    // the registration that just succeeded.
    started = subscriptions.length > 0;
  }
}

/**
 * Everything push leaves OUTSIDE the app process, undone (NATIVE#11).
 *
 * The icon badge is one piece of workspace state that survives after the app is
 * gone. `setNotificationHandler` has always declared `shouldSetBadge: true`, so
 * a signed-out phone kept showing an unread count belonging to a session that no
 * longer exists — visible to the next person to pick it up, and wrong again
 * after a workspace switch.
 *
 * The notification TRAY is the other, and it leaks far more than a count: a
 * delivered banner keeps its title and body, so "Summer Sale finished sending
 * to 12,400 people" and an inbound SMS from a named customer sat in Notification
 * Center after sign-out, readable without unlocking anything else. Dismissing
 * delivered notifications is the tray's equivalent of clearing the badge, and
 * belongs on the same call so every sign-out path gets both.
 *
 * Never rejects: sign-out must complete even when these APIs are unavailable
 * (some Android launchers, simulators, Expo Go).
 */
export async function teardownPushPresence(): Promise<void> {
  stopPushLifecycle();
  await dismissDeliveredNotifications();
  await clearAppBadge();
}

async function dismissDeliveredNotifications(): Promise<void> {
  try {
    await Notifications.dismissAllNotificationsAsync();
  } catch {
    // Best effort. A tray the platform will not let us clear must not stop the
    // badge clear or the rest of the sign-out wipe behind it.
  }
}

/** Tear the listeners down (sign-out, tests). */
export function stopPushLifecycle(): void {
  for (const subscription of subscriptions) {
    try {
      subscription.remove();
    } catch {
      /* ignore */
    }
  }
  subscriptions = [];
  started = false;
}
