/**
 * TimelineEvent — one row in the subscriber drill-down timeline.
 *
 * Renders a small icon, type label, optional campaign subject + detail
 * fragment, and a relative timestamp. The Type vocabulary mirrors
 * apps/api/internal/subscribers/timeline.go (sent/opened/clicked/
 * bounced/unsubscribed/resubscribed/replied/tag_added/tag_removed/
 * list_added/list_removed/suppressed/added/imported_from_*).
 *
 * Unknown types fall through to a neutral "dot" icon + the raw type
 * string as the label so newer-API events don't break older desktop
 * builds.
 */
import type { ReactElement } from "react";

import type { SubscriberTimelineEvent } from "../../lib/api-client";

interface Props {
  event: SubscriberTimelineEvent;
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
    case "complained":
      return "Complained";
    default:
      if (t.startsWith("imported_from_")) {
        return `Imported from ${t.slice("imported_from_".length)}`;
      }
      return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

/* Inline SVG icons — match SubscriberDetailSlideover's existing style
 * (14×14, currentColor, 1.5px stroke). Kept inline so we don't pull a
 * new icon-set dependency. */
function Icon({ type }: { type: string }): ReactElement {
  const t = type.toLowerCase();
  if (t === "sent") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2L1 7l5 2 2 5z" />
        <path d="M6 9l8-7" />
      </svg>
    );
  }
  if (t === "opened") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 5l6 4 6-4" />
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
      </svg>
    );
  }
  if (t === "clicked") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 3v6l2-1.5 1.5 3 1.5-.7L9.5 7l2.5-.5z" />
      </svg>
    );
  }
  if (t === "bounced") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12c2-4 4-4 6-2s4 2 6-2" />
        <path d="M2 14h12" />
      </svg>
    );
  }
  if (t === "replied") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 4l-5 4 5 4" />
        <path d="M4 8h7a3 3 0 013 3v1" />
      </svg>
    );
  }
  if (t === "unsubscribed" || t === "suppressed" || t === "complained") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="6" />
        <path d="M5 8h6" />
      </svg>
    );
  }
  if (t === "resubscribed") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="6" />
        <path d="M5 8h6M8 5v6" />
      </svg>
    );
  }
  if (t === "tag_added" || t === "tag_removed") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 8L8 2h5v5L7 13z" />
        <circle cx="10.5" cy="5.5" r="0.7" fill="currentColor" />
      </svg>
    );
  }
  if (t === "list_added" || t === "list_removed") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 4h10M3 8h10M3 12h7" />
      </svg>
    );
  }
  if (t === "added" || t.startsWith("imported_from_")) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="6" />
        <path d="M5 8h6M8 5v6" />
      </svg>
    );
  }
  // unknown / fallback — neutral dot
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="3" />
    </svg>
  );
}

/** Tiny formatter for the per-event "extra" line. */
function detailFragment(event: SubscriberTimelineEvent): string | null {
  const d = event.detail ?? {};
  if (typeof d.link_url === "string" && d.link_url) return d.link_url;
  if (typeof d.reason === "string" && d.reason) return d.reason;
  if (typeof d.subject === "string" && d.subject) return d.subject;
  if (typeof d.snippet === "string" && d.snippet) return d.snippet;
  if (typeof d.action === "string" && d.action) return d.action;
  return null;
}

export function TimelineEvent({ event }: Props): ReactElement {
  const extra = detailFragment(event);
  return (
    <li className="timeline-row" data-source={event.source}>
      <span className="timeline-icon" aria-hidden="true">
        <Icon type={event.type} />
      </span>
      <span className="timeline-text">
        <strong>{typeLabel(event.type)}</strong>
        {event.subject ? (
          <>
            {" "}
            <span className="muted">·</span>{" "}
            <span>{event.subject}</span>
          </>
        ) : null}
        {extra ? (
          <>
            {" "}
            <span className="muted">·</span>{" "}
            <span
              className="muted"
              title={extra}
              style={{
                display: "inline-block",
                maxWidth: 240,
                verticalAlign: "bottom",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {extra}
            </span>
          </>
        ) : null}
      </span>
      <span className="timeline-time muted" title={event.occurred_at}>
        {relTime(event.occurred_at)}
      </span>
    </li>
  );
}
