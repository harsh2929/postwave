/**
 * hooks/useAppBadgeSync.ts — keep the springboard badge in step with the inbox
 * the user is actually reading.
 *
 * ── THE GAP ────────────────────────────────────────────────────────────────
 * `refreshAppBadge` already runs when a push ARRIVES (lib/pushLifecycle.ts:37) and
 * when registration completes (lib/push.ts:263), and `clearAppBadge` on sign-out.
 * Nothing ran when the count went DOWN. So a user who opened the app and read three
 * notifications kept a badge saying 3 until the next push happened to arrive — the
 * badge only ever told the truth in the direction that adds to it.
 *
 * `setAppBadge` was written for exactly this case ("already-known count") and had no
 * production caller at all.
 *
 * ── THE TRAP THIS AVOIDS ───────────────────────────────────────────────────
 * `useUnreadNotificationCount()` coerces to 0 while loading or offline, deliberately,
 * "so a badge never renders a placeholder". That is right for a number drawn on a
 * screen and WRONG for the springboard badge: syncing it would clear the badge on
 * every cold start, before the feed had loaded, which is worse than the stale count
 * it replaces. The OS badge persists across launches, so writing 0 to it is a claim,
 * not a neutral default.
 *
 * So this reads the query's own data slot and applies the badge only when the feed
 * has genuinely answered. Same query key as the feed, so it shares the cache and
 * costs no extra request.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { fetchNotificationFeed, type NotificationFeed } from "@/api/notifications";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { notificationFeedKey } from "@/hooks/useNotificationFeed";
import { setAppBadge } from "@/lib/appBadge";

export function useAppBadgeSync(): void {
  const gate = useOnlineQueryGate();
  const enabled = gate.enabled && Boolean(gate.tenantId);
  const query = useQuery<NotificationFeed, Error, number>({
    queryKey: notificationFeedKey(gate.tenantId, "all"),
    enabled,
    queryFn: () => fetchNotificationFeed(),
    select: (data) => data.unread_count,
    refetchInterval: 5 * 60_000,
    staleTime: 30_000,
  });

  const unread = query.data;
  useEffect(() => {
    // `undefined` means the feed has not answered on this device yet. Leave the
    // existing badge alone rather than asserting zero.
    if (!enabled || unread === undefined) return;
    void setAppBadge(unread);
  }, [enabled, unread]);
}
