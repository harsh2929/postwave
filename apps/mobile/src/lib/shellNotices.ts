/**
 * lib/shellNotices.ts — copy + telemetry shape for the two places the app
 * shell used to say NOTHING.
 *
 * 1. SHELL#71 — an unrecognised deep link. `planDeepLinkNavigation` returns
 *    `{kind:"ignore"}` for anything that is neither a recognised auth link nor
 *    a recognised entity link, and the root layout's `case "ignore": break`
 *    dropped it. The app opens on whatever screen was last shown, which is
 *    indistinguishable from a normal launch — so a link that the strict URL
 *    grammar rejects (wrong host, folded slash, expired proof) looks like the
 *    app ignoring the user.
 *
 *    Two hard constraints on the feedback:
 *      - A launch with NO url must stay silent. `planDeepLinkNavigation(null)`
 *        also returns "ignore", and toasting every cold start would be worse
 *        than the bug.
 *      - The URL must never be echoed back or sent to telemetry. Magic-link
 *        and reset links carry a single-use PROOF in the query string, and a
 *        malformed one still carries it. Only the scheme and host leave this
 *        module.
 *
 * 2. NATIVE#47 — the share-extension inbox drains one item per foreground, so
 *    sharing three links in a row silently strands two of them with no reason
 *    for the user to come back.
 *
 * Import-free by design: the node vitest environment cannot load a module that
 * transitively imports react-native.
 */

export interface UnrecognisedLinkNotice {
  /** Toast copy. Deliberately contains no part of the URL. */
  message: string;
  /** Lower-cased scheme without the colon ("postwave", "https"), or "". */
  scheme: string;
  /** Lower-cased host, or "" for a scheme-only / unparseable link. */
  host: string;
}

/**
 * Feedback for a link the app could not route. Returns null when there was no
 * link at all, which is the ordinary cold start.
 */
export function unrecognisedLinkNotice(
  rawUrl: string | null | undefined,
): UnrecognisedLinkNotice | null {
  const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!url) return null;
  let scheme = "";
  let host = "";
  try {
    const parsed = new URL(url);
    scheme = parsed.protocol.replace(/:$/u, "").toLowerCase();
    host = parsed.hostname.toLowerCase();
  } catch {
    // Not a parseable URL. Recover the scheme by hand so telemetry can still
    // separate "our scheme, bad path" from "someone else's scheme entirely",
    // and take nothing else.
    const match = /^([a-z][a-z0-9+.-]*):/iu.exec(url);
    scheme = match?.[1]?.toLowerCase() ?? "";
  }
  return {
    message:
      "That link couldn't be opened — Moosewave didn't recognise it. It may have expired or need a newer app version.",
    scheme,
    host,
  };
}

/**
 * Telemetry properties for an ignored link. Scheme and host only: enough to
 * measure the rejection rate and spot a host we forgot to allowlist, and not
 * enough to leak a sign-in proof into an analytics pipeline.
 */
export function unrecognisedLinkTelemetry(
  notice: UnrecognisedLinkNotice,
): Record<string, unknown> {
  return { outcome: "ignored", scheme: notice.scheme, host: notice.host };
}

/**
 * "More shared items are waiting" copy. The inbox is bounded at 8 items, so
 * these counts are always small and always exact — no compaction needed.
 *
 * `null` means the queue could not be READ (App Group unavailable, storage
 * fault). That is not the same as an empty queue, and it must not be reported
 * as "0 more": both produce no notice, but only because saying nothing is the
 * honest answer to "we don't know", not because we counted zero.
 */
export function sharedInboxRemainingNotice(
  remaining: number | null | undefined,
): string | null {
  if (typeof remaining !== "number") return null;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const count = Math.floor(remaining);
  return count === 1
    ? "1 more shared item is waiting."
    : `${count} more shared items are waiting.`;
}

/** Label for the toast action that opens the next queued shared item. */
export const SHARED_INBOX_NEXT_LABEL = "Open next";

/**
 * "You are looking at a WINDOW, not the whole feed."
 *
 * `GET /api/v1/notifications` takes `unread` + `limit` and nothing else —
 * `Repo.List` (apps/api/internal/notification_feed/notification_feed.go) has no
 * cursor and clamps anything above 200 back down to 50, so 200 is the largest
 * page that exists and there is no "next". Mobile already asks for that
 * maximum.
 *
 * What was missing is honesty at the boundary. A workspace with 400
 * notifications renders 200 rows that simply stop, and then "Mark all read"
 * clears the 200 the user never saw. Saying so costs one line and is the only
 * truthful thing available until the endpoint grows a cursor.
 *
 * Returns null below the limit — the ordinary case, where the list IS the feed.
 * A count ABOVE the limit is impossible from a clamped endpoint, but is treated
 * as at-the-limit rather than ignored, so a future server change degrades to an
 * over-cautious notice instead of a silent one.
 */
export function feedWindowNotice(
  itemCount: number,
  limit: number,
): string | null {
  if (!Number.isFinite(itemCount) || !Number.isFinite(limit)) return null;
  if (limit <= 0 || itemCount < limit) return null;
  return `Showing the ${Math.floor(limit)} most recent notifications. Older ones are not loaded — mark these read to see further back.`;
}
