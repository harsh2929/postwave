// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Subscriber drill-down timeline (web).
 *
 * Mirrors apps/desktop/src/components/subscriber/Timeline.tsx in shape
 * but uses the web app's Tailwind/UI primitives. Loads from
 * /api/v1/subscribers/{id}/timeline (Go: apps/api/internal/subscribers/
 * timeline.go) with opaque cursor pagination on the `cursor=` query param.
 *
 * The honest-fallback path (when the endpoint 404s) is handled by the
 * parent page.tsx — this component focuses on rendering the events
 * once a Timeline has been loaded.
 */
import Link from "next/link";
import { type ReactElement, useId, useMemo } from "react";

import type { SubscriberTimelineEvent } from "@/lib/subscriber-timeline-api";

interface TimelineProps {
  events: SubscriberTimelineEvent[];
  hasMore: boolean;
  onLoadMore: () => void;
  loadingMore: boolean;
  /** Inline error for a failed "Load more" — surfaced next to the button so
   *  a pagination failure never wipes the already-loaded timeline. */
  loadMoreError?: string | null;
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  return `${mo}mo ago`;
}

function typeLabel(type: string): string {
  const t = type.toLowerCase();
  switch (t) {
    case "sent":
      return "Sent";
    case "opened":
      return "Opened";
    case "clicked":
      return "Clicked";
    case "bounced":
      return "Bounced";
    case "unsubscribed":
      return "Unsubscribed";
    case "resubscribed":
      return "Resubscribed";
    case "replied":
      return "Replied";
    case "tag_added":
      return "Tag added";
    case "tag_removed":
      return "Tag removed";
    case "list_added":
      return "Added to list";
    case "list_removed":
      return "Removed from list";
    case "suppressed":
      return "Suppressed";
    case "added":
      return "Added";
    default:
      if (t.startsWith("imported_from_")) {
        return `Imported from ${t.slice("imported_from_".length)}`;
      }
      return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

function detailFragment(event: SubscriberTimelineEvent): string | null {
  const d = event.detail ?? {};
  if (typeof d.link_url === "string" && d.link_url) return d.link_url;
  if (typeof d.reason === "string" && d.reason) return d.reason;
  if (typeof d.subject === "string" && d.subject) return d.subject;
  if (typeof d.snippet === "string" && d.snippet) return d.snippet;
  if (typeof d.action === "string" && d.action) return d.action;
  return null;
}

function eventDot(type: string): string {
  const t = type.toLowerCase();
  if (t === "sent" || t === "added" || t.startsWith("imported_from_"))
    return "bg-blue-500";
  if (t === "opened") return "bg-emerald-500";
  if (t === "clicked") return "bg-purple-500";
  if (t === "replied") return "bg-cyan-500";
  if (t === "bounced") return "bg-amber-500";
  if (t === "unsubscribed" || t === "suppressed" || t === "complained")
    return "bg-rose-500";
  return "bg-muted-foreground";
}

export function SubscriberTimeline({
  events,
  hasMore,
  onLoadMore,
  loadingMore,
  loadMoreError,
}: TimelineProps): ReactElement {
  const eventsId = useId();
  const loadMoreErrorId = useId();
  const sorted = useMemo(
    () =>
      [...events].sort(
        (a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at),
      ),
    [events],
  );

  return (
    <div
      data-testid="subscriber-timeline"
      aria-busy={loadingMore}
      className="min-w-0"
    >
      {sorted.length === 0 ? (
        <p
          id={eventsId}
          role="status"
          className="text-sm text-muted-foreground"
        >
          {hasMore
            ? "No activity loaded on this page yet."
            : "No activity recorded for this subscriber."}
        </p>
      ) : (
        <ol
          id={eventsId}
          aria-label="Subscriber activity"
          className="relative ml-2 border-l border-border"
        >
          {sorted.map((ev) => {
            const extra = detailFragment(ev);
            return (
              <li
                key={`${ev.type}-${ev.occurred_at}-${ev.subject_id ?? ""}-${ev.source}`}
                data-testid="timeline-event"
                data-timestamp={ev.occurred_at}
                className="ml-4 min-w-0 pb-4"
                data-source={ev.source}
              >
                <span
                  className={`absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full ${eventDot(ev.type)}`}
                  aria-hidden
                />
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium">{typeLabel(ev.type)}</span>
                  {ev.subject ? (
                    ev.campaign_id ? (
                      // Link campaign events to the campaign so the profile isn't
                      // a terminal read-only view (SUB-008).
                      <Link
                        href={`/app/campaigns/${encodeURIComponent(ev.campaign_id)}`}
                        className="min-w-0 break-words rounded-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        · {ev.subject}
                      </Link>
                    ) : (
                      <span className="min-w-0 break-words text-muted-foreground">
                        · {ev.subject}
                      </span>
                    )
                  ) : null}
                  {extra ? (
                    <span
                      className="min-w-0 max-w-full break-all text-xs text-muted-foreground"
                      title={extra}
                    >
                      · {extra}
                    </span>
                  ) : null}
                  <time
                    className="ml-auto shrink-0 text-xs text-muted-foreground"
                    dateTime={ev.occurred_at}
                    title={ev.occurred_at}
                  >
                    {relTime(ev.occurred_at)}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {hasMore ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-busy={loadingMore}
            aria-controls={eventsId}
            aria-describedby={loadMoreError ? loadMoreErrorId : undefined}
            className="inline-flex min-h-11 items-center justify-center rounded-md border bg-background px-3 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : loadMoreError ? "Retry" : "Load more"}
          </button>
          {loadMoreError ? (
            // Inline, scoped error — the loaded timeline above stays intact.
            <span
              id={loadMoreErrorId}
              role="alert"
              className="min-w-0 break-words text-xs text-destructive-emphasis"
            >
              Couldn’t load more: {loadMoreError}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
