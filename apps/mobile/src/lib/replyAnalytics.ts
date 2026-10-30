/**
 * lib/replyAnalytics.ts — workspace-level reply intelligence, pure.
 *
 * Three sibling reads, all `read:reports` / viewer, all mounted by
 * apps/api/internal/reply_analytics/reply_analytics.go:
 *
 *   GET /api/v1/replies/summary?days=N            (:63)  totals + classification
 *   GET /api/v1/replies/timeseries?days=N         (:275) gap-filled daily counts
 *   GET /api/v1/replies/top-senders?days=N&limit  (:224) who replies most
 *
 * Before this module the phone could read ONE campaign's reply feed at a time
 * (`/replies/by-campaign/{id}`) and nothing else — no volume, no trend, no
 * "who actually writes back". The desktop answers all three in its
 * ConversationsPanel; this is the arithmetic and the copy behind the phone's
 * answer, kept free of React so every rule is node-tested.
 *
 * Three wire facts the copy leans on (all from the handler's SQL):
 *
 *  - `total` counts EVERY inbound row; `human_replies` is the classified
 *    subset, and `total = human + excluded_non_human + unclassified` exactly
 *    (classify.go:312-325). Reporting the raw total as engagement would
 *    flatter every out-of-office season, so the headline carries both.
 *  - The TIMESERIES and TOP SENDERS are unfiltered — no classification
 *    predicate in either query — so their counts can exceed what the human
 *    figure implies. The captions say so rather than letting the numbers
 *    disagree in silence.
 *  - The server writes no sentence of its own for any of the three, so the
 *    empty and insufficient states here are the phone's words, not a
 *    server-authored line rendered verbatim.
 *
 * PARSE CONTRACT: each parser answers `null` for a payload it cannot read
 * (not an object, or missing its load-bearing field). The api layer turns
 * that into a thrown error; it never turns it into a zeroed card, because a
 * truncated response rendered as "No replies" reads as a fact about the
 * audience rather than a fact about the connection.
 */
import { num } from "@/lib/format";

/* ------------------------------- copy --------------------------------- */

export const REPLIES_TITLE = "Replies";
export const REPLIES_SUBTITLE = "Inbound replies to this workspace's sends.";
export const REPLIES_ABSENT_COPY =
  "This workspace doesn't expose reply analytics.";
export const REPLIES_OFFLINE_COPY =
  "You're offline and reply analytics haven't been cached yet. They'll load when you reconnect.";
export const REPLIES_EMPTY_HEADLINE = "No replies in this window.";
export const TREND_TITLE = "Replies per day";
export const TREND_NO_POINTS =
  "No daily reply counts were reported for this window, so there is no trend to draw.";
export const TREND_ONE_POINT =
  "Only one day of reply counts is available; a trend needs at least two.";
export const TOP_SENDERS_TITLE = "Top responders";
export const TOP_SENDERS_CAPTION =
  "Ranked by every reply, including automatic ones — the classification in the headline does not filter this list.";
/** What the phone asks the server for; the desktop controller asks for 8 too. */
export const TOP_SENDERS_LIMIT = 8;
/** How many of them the card shows (desktop slices to 6 as well). */
export const TOP_SENDERS_SHOWN = 6;

/**
 * The screen window as reply-endpoint days. Deliberately a lib sibling of
 * `daysForRange` (hooks/useAnalytics) rather than an import from it: screen
 * tests replace that hooks module with a closed mock, and a section that
 * reaches into it for a constant breaks the moment the mock does not list it.
 */
export function replyWindowDays(range: string): number {
  return range === "7d" ? 7 : range === "90d" ? 90 : 30;
}

/** The card's closing caveat: which numbers are filtered and which are not. */
export function replyWindowCaption(rangeLabel: string): string {
  return `${rangeLabel}. Counts every inbound reply, including automatic ones; "written by people" is the subset the server classified as human.`;
}

/* ------------------------------ parsing -------------------------------- */

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function count(value: unknown): number {
  return isCount(value) ? Math.trunc(value) : 0;
}

export interface ReplySummary {
  windowDays: number;
  total: number;
  humanReplies: number;
  excludedNonHuman: number;
  unclassified: number;
  matched: number;
  unmatched: number;
}

/**
 * Null when unreadable. `total` is the load-bearing field: without it there
 * is no headline, and a headline of "No replies" built from a missing key
 * would be the exact false sentence this module exists to refuse.
 */
export function parseReplySummary(raw: unknown): ReplySummary | null {
  const row = record(raw);
  if (!row || !isCount(row.total)) return null;
  return {
    windowDays: count(row.window_days),
    total: count(row.total),
    humanReplies: count(row.human_replies),
    excludedNonHuman: count(row.excluded_non_human),
    unclassified: count(row.unclassified_replies),
    matched: count(row.matched),
    unmatched: count(row.unmatched),
  };
}

export interface ReplyPoint {
  date: string;
  /** Null when the day carried no readable count — a GAP, never a zero. */
  replies: number | null;
}

/** Null when unreadable; an empty array when the window has no rows. */
export function parseReplyTimeseries(raw: unknown): ReplyPoint[] | null {
  const row = record(raw);
  if (!row) return null;
  const points = Array.isArray(row.points) ? row.points : [];
  const out: ReplyPoint[] = [];
  for (const entry of points) {
    const point = record(entry);
    if (!point || typeof point.date !== "string" || !point.date) continue;
    out.push({
      date: point.date,
      replies: isCount(point.replies) ? Math.trunc(point.replies) : null,
    });
  }
  return out;
}

export interface ReplyTopSender {
  email: string;
  replies: number;
  /** ISO timestamp of the most recent reply, or null when not reported. */
  lastAt: string | null;
}

/** Null when unreadable; an empty array when nobody replied. */
export function parseReplyTopSenders(raw: unknown): ReplyTopSender[] | null {
  const row = record(raw);
  if (!row) return null;
  const senders = Array.isArray(row.senders) ? row.senders : [];
  const out: ReplyTopSender[] = [];
  for (const entry of senders) {
    const sender = record(entry);
    if (!sender) continue;
    const email =
      typeof sender.recipient_email === "string"
        ? sender.recipient_email.trim()
        : "";
    if (!email) continue;
    out.push({
      email,
      replies: count(sender.replies),
      lastAt:
        typeof sender.last_at === "string" && sender.last_at
          ? sender.last_at
          : null,
    });
  }
  return out;
}

/* ------------------------------- copy rules ---------------------------- */

function replyNoun(n: number): string {
  return n === 1 ? "reply" : "replies";
}

/**
 * "212 replies · 180 written by people".
 *
 * When NOTHING has been classified yet (no human, no excluded — so every row
 * is unclassified) the headline says so instead of "0 written by people",
 * which would read as "nobody real wrote back" about a batch the classifier
 * simply has not reached.
 */
export function replyHeadline(summary: ReplySummary): string {
  if (summary.total === 0) return REPLIES_EMPTY_HEADLINE;
  const volume = `${num(summary.total)} ${replyNoun(summary.total)}`;
  if (summary.humanReplies === 0 && summary.excludedNonHuman === 0) {
    return `${volume} · not yet classified`;
  }
  return `${volume} · ${num(summary.humanReplies)} written by people`;
}

/**
 * The classification/matching disclosure under the headline. Only states the
 * parts that are non-zero — a caption full of zeroes buries the one that
 * matters.
 */
export function replyProvenanceCaption(summary: ReplySummary): string | null {
  if (summary.total === 0) return null;
  const parts: string[] = [];
  if (summary.excludedNonHuman > 0) {
    parts.push(
      `${num(summary.excludedNonHuman)} auto-responders and bounce chatter excluded`,
    );
  }
  if (summary.unclassified > 0) {
    parts.push(`${num(summary.unclassified)} not yet classified`);
  }
  if (summary.unmatched > 0) {
    parts.push(`${num(summary.unmatched)} not matched to a campaign`);
  }
  return parts.length > 0 ? `${parts.join(" · ")}.` : null;
}

/* ------------------------------- the trend ----------------------------- */

export type ReplyTrend =
  | { kind: "chart"; labels: string[]; values: (number | null)[] }
  | { kind: "insufficient"; message: string }
  /** The headline already says there were no replies; a flat line adds nothing. */
  | { kind: "none" };

/**
 * Whether the daily series can honestly be drawn.
 *
 * A flat-at-zero run with a non-zero total IS drawable (the two reads use
 * slightly different day boundaries, so a reply at the window's edge can
 * land in one and not the other); the chart's own scale pads a flat zero
 * series upward rather than dividing by it. Fewer than two MEASURED days is
 * not a trend, and the card says so instead of drawing a dot.
 */
export function replyTrend(
  points: readonly ReplyPoint[],
  total: number,
): ReplyTrend {
  if (total === 0) return { kind: "none" };
  const measured = points.filter((p) => p.replies !== null).length;
  if (points.length === 0) {
    return { kind: "insufficient", message: TREND_NO_POINTS };
  }
  if (measured < 2) {
    return { kind: "insufficient", message: TREND_ONE_POINT };
  }
  return {
    kind: "chart",
    labels: points.map((p) => p.date),
    values: points.map((p) => p.replies),
  };
}

/* ------------------------------ responders ----------------------------- */

export interface ResponderRow {
  key: string;
  email: string;
  replies: number;
  /** "3 replies" — the visible count. */
  countLabel: string;
  /** Raw ISO timestamp for the component to format, or null. */
  lastAt: string | null;
  /** The VoiceOver frame for the row. */
  spoken: string;
  /** Against the biggest replier, so the bars rank visually. 0..1. */
  share: number;
}

export function topSenderRows(
  senders: readonly ReplyTopSender[],
  limit = TOP_SENDERS_SHOWN,
): ResponderRow[] {
  const max = senders.reduce((m, s) => Math.max(m, s.replies), 0);
  return senders.slice(0, Math.max(0, limit)).map((sender, i) => {
    const countLabel = `${num(sender.replies)} ${replyNoun(sender.replies)}`;
    return {
      key: `${sender.email}-${i}`,
      email: sender.email,
      replies: sender.replies,
      countLabel,
      lastAt: sender.lastAt,
      spoken: `${sender.email}, ${countLabel}`,
      share: max > 0 ? sender.replies / max : 0,
    };
  });
}
