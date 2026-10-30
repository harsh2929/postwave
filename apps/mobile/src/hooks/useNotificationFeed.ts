/**
 * hooks/useNotificationFeed.ts — the notification feed and its unread count.
 *
 * The count was already in the payload (`unread_count`) and rendered NOWHERE:
 * no bell, no tab badge, no app-icon badge. Grep for `unread_count` across
 * apps/mobile returned two hits, both inside the API module. Desktop shows a
 * 99+-capped bell count on every screen.
 *
 * `useUnreadNotificationCount` deliberately reuses the SAME query key the inbox
 * screen's default (All) view uses, so a badge on the More tab and the More row
 * costs zero extra requests — it reads whatever the shared cache already holds.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchNotificationFeed,
  type NotificationFeed,
} from "@/api/notifications";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

/** Query-key root the realtime layer invalidates on `notification.created`. */
export const NOTIFICATION_FEED_ROOT = "notification-feed";

export type NotificationFilter = "all" | "unread";

export function notificationFeedKey(
  tenantId: string | null,
  filter: NotificationFilter,
): (string | null)[] {
  return [NOTIFICATION_FEED_ROOT, tenantId, filter];
}

/**
 * Cap for the tab/row badge. Beyond this the exact number stops being
 * actionable and starts breaking the tab bar's layout.
 */
export const NOTIFICATION_BADGE_CAP = 99;

/** `12`, or `99+` past the cap. Empty string at zero so callers can omit. */
export function badgeLabel(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return count > NOTIFICATION_BADGE_CAP
    ? `${NOTIFICATION_BADGE_CAP}+`
    : String(Math.floor(count));
}

/**
 * The EXACT count behind a capped badge, for a spoken label. `badgeLabel` caps
 * at 99 because the tab bar has a fixed pill to fit the number into; speech has
 * no such constraint, and "ninety-nine plus" withholds from a screen-reader user
 * the one thing a count is for. Empty string at zero, so a caller can spread it
 * conditionally exactly like `badgeLabel`.
 */
export function badgeSpokenCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return String(Math.floor(count));
}

/**
 * Spoken label for a badge. React Navigation renders `tabBarBadge` as a purely
 * decorative view, so without this a VoiceOver user hears "Notifications, tab 5
 * of 5" and never learns that 12 items are waiting.
 */
export function badgeAccessibilityLabel(base: string, count: number): string {
  if (!Number.isFinite(count) || count <= 0) return base;
  const n = Math.floor(count);
  return `${base}, ${n} unread`;
}

export function useNotificationFeed(filter: NotificationFilter = "all") {
  const gate = useOnlineQueryGate();
  return useQuery<NotificationFeed>({
    queryKey: notificationFeedKey(gate.tenantId, filter),
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: () =>
      fetchNotificationFeed(filter === "unread" ? { unreadOnly: true } : {}),
    // The realtime event bus already invalidates this root on
    // `notification.created`, so a tight poll is mostly redundant traffic —
    // and every poll used to drive the pull-to-refresh spinner. Five minutes
    // is a safety net for a dropped subscription, not the primary channel.
    refetchInterval: 5 * 60_000,
    staleTime: 30_000,
  });
}

/**
 * Just the unread count, from the shared cache. Returns 0 while loading or
 * offline so a badge never renders a placeholder.
 */
export function useUnreadNotificationCount(): number {
  const gate = useOnlineQueryGate();
  const query = useQuery<NotificationFeed, Error, number>({
    queryKey: notificationFeedKey(gate.tenantId, "all"),
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: () => fetchNotificationFeed(),
    select: (data) => data.unread_count,
    refetchInterval: 5 * 60_000,
    staleTime: 30_000,
  });
  return query.data ?? 0;
}
