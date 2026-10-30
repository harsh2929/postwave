/**
 * Durable notification center anchored to the TopBar bell.
 *
 * Actionable realtime events are written to encrypted, identity-scoped local
 * history before optional OS delivery. This panel owns explicit read/archive
 * state and routes only through the shared, validated deep-link contract.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { useDialogStack } from "../hooks/useDialogStack";
import { pushDialog, popDialog } from "../lib/dialogStack";
import {
  markAllNotificationsRead,
  setNotificationArchived,
  useNotificationCenter,
} from "../lib/notification-center";
import type { UnifiedNotificationRow } from "../lib/notification-feed-reconcile";
import { useNotificationInbox } from "../lib/notification-inbox-store";
import { openUnifiedNotificationRow } from "../lib/notification-navigation";
import { timeAgo } from "./notifications-panel-helpers";

export {
  destinationForNotification,
  hasRecentActivity,
  isUserFacingActivity,
  prettyAction,
  timeAgo,
} from "./notifications-panel-helpers";

export type NotificationPanelCloseReason =
  | "escape"
  | "outside"
  | "button"
  | "selection";

interface Props {
  open: boolean;
  onClose: (reason?: NotificationPanelCloseReason) => void;
}

type ListFilter = "all" | "unread";

const notificationTimeFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
});

function absoluteNotificationTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "time unavailable"
    : notificationTimeFormatter.format(date);
}

function deliveryCopy(entry: {
  delivery: UnifiedNotificationRow["delivery"];
}): string | null {
  switch (entry.delivery) {
    case "unknown":
      // Raised while this machine was closed, or on another device. Naming it
      // is the honest alternative to implying a banner was shown here.
      return "Received on another device.";
    case "failed":
      return "Saved here; the desktop alert could not be delivered.";
    case "suppressed-quiet-hours":
      return "Delivered quietly during quiet hours.";
    case "suppressed-foreground":
      return "Kept here while Moosewave was active.";
    case "suppressed-disabled":
    case "suppressed-topic":
      return "Kept in Notification Center.";
    default:
      return null;
  }
}

export function NotificationsPanel({
  open,
  onClose,
}: Props): ReactElement | null {
  const center = useNotificationCenter();
  // The unified inbox: this machine's encrypted history PLUS notifications
  // raised on the user's other devices, correlated so a pair renders once.
  // Falls back to vault-only rows until the first feed read settles, so the
  // panel never blanks while the network is slow.
  const inbox = useNotificationInbox();
  const [filter, setFilter] = useState<ListFilter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const closeRequestedRef = useRef(false);
  const titleId = useId();
  const dialogId = useId();
  const { isTop } = useDialogStack(dialogId);
  const requestClose = useCallback(
    (reason: NotificationPanelCloseReason): void => {
      if (closeRequestedRef.current) return;
      closeRequestedRef.current = true;
      onClose(reason);
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    closeRequestedRef.current = false;
    pushDialog(dialogId);
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      popDialog(dialogId);
    };
  }, [open, dialogId]);

  useEffect(() => {
    if (!open) return;
    const onDocumentDown = (event: PointerEvent): void => {
      const panel = panelRef.current;
      if (!panel || !(event.target instanceof Node)) return;
      if (panel.contains(event.target)) return;
      const target = event.target as HTMLElement;
      if (target.closest("[data-pw-notif-trigger]")) return;
      requestClose("outside");
    };
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (
        target instanceof HTMLElement &&
        target.closest("[data-pw-notif-trigger]")
      ) {
        return;
      }
      requestClose("outside");
    };
    document.addEventListener("pointerdown", onDocumentDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("pointerdown", onDocumentDown, true);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open, requestClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== "Escape" || !isTop) return;
      event.preventDefault();
      requestClose("escape");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isTop, open, requestClose]);

  /**
   * Rows to render. Uses the synced union once available and the raw vault
   * before then — the two have the same shape from this component's point of
   * view, so there is no flash and no second code path.
   */
  const rows: readonly UnifiedNotificationRow[] = useMemo(() => {
    if (inbox.rows.length > 0) return inbox.rows;
    return center.entries.map((entry) => ({
      key: entry.id,
      localId: entry.id,
      serverId: null,
      source: "local" as const,
      eventType: entry.topic,
      title: entry.title,
      body: entry.body,
      deepLink: entry.deepLink,
      createdAt: entry.createdAt,
      readAt: entry.readAt,
      seenAt: null,
      archivedAt: entry.archivedAt,
      delivery: entry.delivery,
      topic: entry.topic,
    }));
  }, [inbox.rows, center.entries]);

  const visibleEntries = useMemo(
    () =>
      rows.filter((row) => {
        if ((row.archivedAt !== null) !== showArchived) return false;
        return filter === "all" || row.readAt === null;
      }),
    [rows, filter, showArchived],
  );

  // One count, shared with the bell and the tray (lib/notification-inbox-store).
  // Before the feed settles the store has no rows, so fall back to the vault's
  // own count rather than showing 0 over a populated list.
  const unreadCount =
    inbox.rows.length > 0
      ? inbox.unreadCount
      : rows.filter((row) => row.archivedAt === null && row.readAt === null)
          .length;

  if (!open) return null;

  const openEntry = (row: UnifiedNotificationRow): void => {
    if (closeRequestedRef.current) return;
    openUnifiedNotificationRow(row);
    requestClose("selection");
  };

  return (
    <div
      ref={panelRef}
      id="desktop-notification-center"
      className="notif-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
    >
      <div className="notif-panel-header">
        <div>
          <div id={titleId} className="notif-panel-title">
            Notifications
          </div>
          <div className="notif-panel-summary" aria-live="polite">
            {unreadCount === 0
              ? "No unread notifications"
              : `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`}
          </div>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => requestClose("button")}
          aria-label="Close notifications"
        >
          Close
        </button>
      </div>

      <div className="notif-panel-tools">
        <div
          className="notif-filter"
          role="group"
          aria-label="Filter notifications"
        >
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-pressed={filter === "unread"}
            onClick={() => setFilter("unread")}
          >
            Unread
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-pressed={showArchived}
            onClick={() => {
              if (!showArchived) setFilter("all");
              setShowArchived((current) => !current);
            }}
          >
            Archived
          </button>
        </div>
        {!showArchived && unreadCount > 0 ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={markAllNotificationsRead}
          >
            Mark all read
          </button>
        ) : null}
      </div>

      {inbox.status === "error" ? (
        <div className="notif-persist-error" role="status">
          Couldn&rsquo;t refresh from the server — showing what&rsquo;s on this
          Mac. Notifications from your other devices may be missing.
        </div>
      ) : null}

      {center.persistError ? (
        <div className="notif-persist-error" role="alert">
          Notification history could not be saved securely. Keep Moosewave open
          and try again after unlocking the device keychain.
        </div>
      ) : null}

      <div className="notif-panel-body">
        {center.identity === "loading" ? (
          <div className="notif-panel-empty" role="status">
            Loading encrypted history…
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="notif-panel-empty">
            <strong>
              {showArchived
                ? "No archived notifications"
                : filter === "unread"
                  ? "You're all caught up"
                  : "No notifications yet"}
            </strong>
            <span>
              {showArchived
                ? "Archived items remain restorable until local history is cleared."
                : "High-signal campaign, approval, and deliverability events appear here."}
            </span>
          </div>
        ) : (
          <div className="notif-list" aria-label="Notification history">
            {visibleEntries.map((entry) => {
              const status = deliveryCopy(entry);
              return (
                <article
                  key={entry.key}
                  className={`notif-row${entry.readAt === null ? " is-unread" : ""}`}
                >
                  <button
                    type="button"
                    className="notif-row-main"
                    onClick={() => openEntry(entry)}
                  >
                    <span className="notif-row-heading">
                      <span className="notif-row-action">{entry.title}</span>
                      {entry.readAt === null ? (
                        <span className="notif-unread-label">Unread</span>
                      ) : null}
                    </span>
                    <span className="notif-row-body">{entry.body}</span>
                    <span className="notif-row-meta">
                      <time dateTime={entry.createdAt}>
                        {timeAgo(entry.createdAt)} ·{" "}
                        {absoluteNotificationTime(entry.createdAt)}
                      </time>
                      {status ? <span>{status}</span> : null}
                    </span>
                  </button>
                  {/* Archive is a LOCAL concept — the server models none — so
                      the control only appears for a row this machine holds.
                      Showing a disabled button on every cross-device row would
                      be noise; showing an enabled one would be a lie. */}
                  {entry.localId ? (
                    <button
                      type="button"
                      className="notif-row-archive"
                      onClick={() =>
                        setNotificationArchived(
                          entry.localId!,
                          entry.archivedAt === null,
                        )
                      }
                      aria-label={`${entry.archivedAt === null ? "Archive" : "Restore"} ${entry.title}`}
                    >
                      {entry.archivedAt === null ? "Archive" : "Restore"}
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
