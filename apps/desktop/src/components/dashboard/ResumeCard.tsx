/**
 * ResumeCard — "Continue where you left off", desktop side.
 *
 * Reads the cross-device cursor the user's other devices wrote (see
 * lib/activity-cursor) and offers one click back to it. Renders NOTHING when
 * there is no cursor, when the user is signed out, or when the reference points
 * at an entity this surface cannot open — so a fresh session and a broken
 * endpoint both look like an ordinary dashboard rather than an empty box.
 *
 * The label names the entity TYPE ("Campaign · viewed 12m ago"), never a title:
 * the server stores an id reference and no content, and showing a name would
 * imply otherwise.
 */
import { useEffect, useState, type ReactElement } from "react";

import {
  activityCursor,
  resumeHref,
  resumeTypeLabel,
  type ActivityCursor,
} from "../../lib/activity-cursor";
import {
  navigateDesktopRoute,
  parseDesktopRoute,
} from "../../lib/desktop-router";

/** Coarse "how long ago", enough for a continuity hint. */
function viewedAgo(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const mins = Math.floor((Date.now() - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function ResumeCard(): ReactElement | null {
  const [cursor, setCursor] = useState<ActivityCursor | null>(null);

  useEffect(() => {
    let cancelled = false;
    void activityCursor.fetchLastViewed().then((next) => {
      if (!cancelled) setCursor(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const href = cursor ? resumeHref(cursor) : null;
  // Resolve the destination through the ROUTER'S OWN grammar rather than
  // mapping slug→section here. `resumeHref` emits the canonical
  // `/app/<slug>/<id>`; `parseDesktopRoute` is the same parser the deep-link
  // handler uses, so the card cannot navigate anywhere the shell would reject.
  // A path the router refuses means no card at all — never a dead button.
  const parsed = href ? parseDesktopRoute(href) : null;
  if (!cursor || !parsed?.ok) return null;
  const route = parsed.route;

  const ago = viewedAgo(cursor.viewed_at);

  return (
    <button
      type="button"
      className="resume-card"
      data-testid="resume-card"
      onClick={() => navigateDesktopRoute(route, { source: "navigation" })}
    >
      <span className="resume-card__body">
        <span className="resume-card__title">Continue where you left off</span>
        <span className="resume-card__meta">
          {resumeTypeLabel(cursor)}
          {ago ? ` · viewed ${ago}` : ""}
        </span>
      </span>
      <span aria-hidden className="resume-card__chevron">
        →
      </span>
    </button>
  );
}
