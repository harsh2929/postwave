// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bell,
  CreditCard,
  Gavel,
  Info,
  Loader2,
  Mail,
  ShieldAlert,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { notificationFeedApi } from "@/lib/notification-feed-api";
import { notificationFeedDestination } from "@/lib/notification-destination";
import { qk, STALE, type RoleKey } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";
import { useDisclosure } from "@/lib/use-disclosure";
import { absoluteTime, timeAgo } from "@/lib/relative-time";

// Per-kind icon so a row's type is glanceable (SHELL-008). Unknown kinds fall
// back to the bell so a new server-side kind is never a blank.
const KIND_ICONS: Record<string, typeof Bell> = {
  campaign: Mail,
  send: Mail,
  delivery: Mail,
  billing: CreditCard,
  invoice: CreditCard,
  approval: Gavel,
  approvals: Gavel,
  security: ShieldAlert,
  warning: AlertTriangle,
  alert: AlertTriangle,
  subscriber: Users,
  team: Users,
  system: Info,
};

function kindIcon(kind: string | undefined): typeof Bell {
  return (kind && KIND_ICONS[kind]) || Bell;
}

export function NotificationBell({
  tenantId,
  role,
}: {
  tenantId: string;
  role: RoleKey;
}) {
  const [open, setOpen] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const viewAllRef = useRef<HTMLAnchorElement | null>(null);
  const markSeenInFlightRef = useRef(false);
  const markAllInFlightRef = useRef(false);
  const panelId = useId();
  const client = useQueryClient();
  const key = qk.notificationFeed(tenantId, role);
  const feed = useQuery({
    queryKey: key,
    queryFn: () => notificationFeedApi.list(20),
    enabled: tenantId !== "anon",
    staleTime: STALE.list,
    // api.request already performs its own bounded transport retry. A second
    // TanStack retry layer turned one broken feed into nine requests before the
    // panel could show its actionable error state.
    retry: false,
    // Poll every 60s normally, but back off to 5 minutes after a failure so a
    // broken notifications backend isn't hammered on a tight 60s loop (OVR-011).
    // (Realtime `notification.created` invalidation keeps this near-instant when
    // the event bus is up — SHELL-034.)
    refetchInterval: (query) =>
      query.state.status === "error" ? 5 * 60_000 : 60_000,
  });
  const unreadCount = feed.data?.unread_count ?? 0;

  // Escape-to-close, outside-click, focus-into-panel, and focus-restore to the
  // bell — the same accessible disclosure the header menus use (SHELL-005).
  useDisclosure({
    open,
    setOpen,
    triggerRef: buttonRef,
    panelRef,
    focusPanelOnOpen: true,
  });

  // In-app nudge when new notifications arrive while the tab is open — the
  // "push feel" over pure polling (SHELL-034). Skip the first resolved value so
  // we don't toast the initial backlog on mount.
  const prevUnreadRef = useRef<number | null>(null);
  useEffect(() => {
    if (feed.data === undefined) return;
    const prev = prevUnreadRef.current;
    if (prev !== null && unreadCount > prev && !open) {
      const delta = unreadCount - prev;
      toast.info(
        delta === 1 ? "New notification" : `${delta} new notifications`,
      );
    }
    prevUnreadRef.current = unreadCount;
  }, [feed.data, unreadCount, open]);

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (
      next &&
      (feed.data?.unread_count ?? 0) > 0 &&
      !markSeenInFlightRef.current
    ) {
      markSeenInFlightRef.current = true;
      void notificationFeedApi
        .markSeen()
        .then(() => client.invalidateQueries({ queryKey: key, exact: true }))
        .catch(() => {
          // Seeing the panel is still useful if this best-effort receipt fails;
          // the unread badge remains the truthful source of state.
        })
        .finally(() => {
          markSeenInFlightRef.current = false;
        });
    }
  };

  const markAllRead = async (): Promise<void> => {
    if (markAllInFlightRef.current) return;
    markAllInFlightRef.current = true;
    setMarkingAll(true);
    try {
      await notificationFeedApi.markReadAll();
      await client.invalidateQueries({ queryKey: key, exact: true });
      // The successful refetch removes the focused "Mark all read" control.
      // Move to the panel's stable destination instead of letting focus fall
      // back to <body> while this non-modal dialog remains open.
      requestAnimationFrame(() =>
        viewAllRef.current?.focus({ preventScroll: true }),
      );
    } catch {
      toast.error("Notifications could not be marked as read. Try again.");
    } finally {
      markAllInFlightRef.current = false;
      setMarkingAll(false);
    }
  };

  const retryFeed = async (): Promise<void> => {
    const result = await feed.refetch();
    if (result.isError) return;
    // Retry is conditionally replaced by the resolved empty/list state. Keep
    // keyboard focus inside the still-open disclosure on its stable footer.
    requestAnimationFrame(() =>
      viewAllRef.current?.focus({ preventScroll: true }),
    );
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={
          feed.isError
            ? "Notifications (unavailable)"
            : `Notifications${unreadCount ? ` (${unreadCount} unread)` : ""}`
        }
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={panelId}
        onClick={toggle}
        className="relative inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 ? (
          <span className="absolute right-1 top-1 min-w-4 rounded-full bg-destructive px-1 text-[10px] leading-4 text-destructive-foreground">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : feed.isError ? (
          // Surface a subtle muted dot when the feed itself failed, so a broken
          // notifications backend is visible from the closed bell (SHELL-003).
          <span
            aria-hidden
            title="Notifications are temporarily unavailable"
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-muted-foreground/70 ring-2 ring-card"
          />
        ) : null}
      </button>
      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          aria-busy={feed.isPending || undefined}
          className="fixed inset-x-2 top-16 z-50 mt-0 flex max-h-[calc(100dvh-4.5rem)] flex-col overflow-hidden rounded-md border bg-popover p-2 text-popover-foreground shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[min(22rem,calc(100vw-2rem))] max-[359px]:top-[6.5rem] max-[359px]:max-h-[calc(100dvh-7rem)]"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 px-2 py-1">
            <h2 className="text-sm font-medium">Notifications</h2>
            {(feed.data?.unread_count ?? 0) > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="min-h-11 sm:min-h-8"
                loading={markingAll}
                onClick={() => void markAllRead()}
              >
                {markingAll ? "Marking…" : "Mark all read"}
              </Button>
            ) : null}
          </div>
          {feed.isPending ? (
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="flex min-h-24 items-center justify-center gap-2 px-2 py-4 text-sm text-muted-foreground"
            >
              <Loader2
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
              Loading notifications…
            </div>
          ) : feed.isError ? (
            <div role="alert" className="px-2 py-4">
              <p className="text-sm text-destructive-emphasis">
                Notifications could not be loaded.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2 min-h-11 sm:min-h-8"
                onClick={() => void retryFeed()}
                loading={feed.isFetching}
              >
                {feed.isFetching ? "Retrying…" : "Retry"}
              </Button>
            </div>
          ) : (feed.data?.items?.length ?? 0) === 0 ? (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              No notifications yet.
            </p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-auto overscroll-contain">
              {feed.data?.items?.map((item) => {
                const KindIcon = kindIcon(item.kind);
                const destination = notificationFeedDestination(item);
                const rel = timeAgo(item.created_at);
                const unread = !item.read_at;
                const content = (
                  <div className="flex gap-2">
                    <KindIcon
                      className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">
                        {item.title}
                      </span>
                      {item.body ? (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {item.body}
                        </span>
                      ) : null}
                      {rel ? (
                        <span
                          className="mt-0.5 block text-[11px] text-muted-foreground"
                          title={absoluteTime(item.created_at)}
                        >
                          {rel}
                        </span>
                      ) : null}
                    </div>
                    {unread ? (
                      <>
                        <span
                          aria-hidden
                          className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary"
                        />
                        <span className="sr-only">Unread</span>
                      </>
                    ) : null}
                  </div>
                );
                // The unread dot already communicates state. Lowering the
                // opacity of the entire read row also lowers its body and
                // timestamp below WCAG contrast thresholds, particularly on
                // the popover surface.
                const className =
                  "block min-h-11 rounded px-2 py-2 hover:bg-accent";
                return (
                  <li key={item.id}>
                    {destination ? (
                      <Link
                        href={asRoute(destination)}
                        className={className}
                        onClick={() => {
                          setOpen(false);
                          void notificationFeedApi
                            .markRead(item.id)
                            .then(() =>
                              client.invalidateQueries({
                                queryKey: key,
                                exact: true,
                              }),
                            )
                            .catch(() =>
                              toast.error(
                                "That notification could not be marked as read.",
                              ),
                            );
                        }}
                      >
                        {content}
                      </Link>
                    ) : (
                      <div className={className}>{content}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-1 shrink-0 border-t pt-1">
            <Link
              ref={viewAllRef}
              href={asRoute("/app/notifications")}
              onClick={() => setOpen(false)}
              className="flex min-h-11 items-center justify-center rounded px-2 py-2 text-center text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground sm:min-h-9"
            >
              View all
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
