/**
 * notification-inbox-store — the rows the bell renders, and nothing else.
 *
 * A deliberately tiny store with NO transport imports. The panel needs the
 * unified rows; the sync module (`notification-feed-sync.ts`) produces them.
 * Wiring the panel directly to the sync module would pull `api-client` — and
 * through it the router — into every component that renders a notification,
 * which is exactly what broke the panel's test mock the first time this was
 * attempted.
 *
 * So the dependency runs one way: sync WRITES here, the panel READS here, and
 * neither imports the other.
 */

import { useSyncExternalStore } from "react";

import type { UnifiedNotificationRow } from "./notification-feed-reconcile";

export interface NotificationInboxState {
  /**
   * Unread across the UNIFIED rows. The bell and the tray read this so they
   * cannot disagree with the panel: the vault's own `unreadCount` counts only
   * notifications this machine received, so a cross-device row made the badge
   * say 0 over a panel saying 1.
   */
  unreadCount: number;
  /**
   * `local` until the first feed read settles. The distinction matters: a
   * panel showing only vault entries because the feed has not loaded is in a
   * different state from one showing only vault entries because the feed READ
   * FAILED, and neither is "you're all caught up".
   */
  status: "local" | "synced" | "error";
  rows: readonly UnifiedNotificationRow[];
}

const EMPTY: NotificationInboxState = {
  status: "local",
  rows: [],
  unreadCount: 0,
};

let state: NotificationInboxState = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setNotificationInbox(
  next: Omit<NotificationInboxState, "unreadCount">,
): void {
  state = {
    ...next,
    // Derived here, once, so every surface counts the same thing. Archived is a
    // local concept and an archived row is not pending work.
    unreadCount: next.rows.filter(
      (row) => row.archivedAt === null && row.readAt === null,
    ).length,
  };
  emit();
}

/**
 * Drop everything. Called when the vault closes (sign-out / workspace switch):
 * these rows belong to the identity that is going away, and leaving them would
 * show one account's notifications to the next.
 */
export function clearNotificationInbox(): void {
  if (state === EMPTY) return;
  state = EMPTY;
  emit();
}

export function getNotificationInbox(): NotificationInboxState {
  return state;
}

export function subscribeNotificationInbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNotificationInbox(): NotificationInboxState {
  return useSyncExternalStore(
    subscribeNotificationInbox,
    getNotificationInbox,
    getNotificationInbox,
  );
}
