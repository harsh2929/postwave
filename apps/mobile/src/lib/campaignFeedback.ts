/**
 * lib/campaignFeedback.ts — the per-campaign review thread, as data.
 *
 * WHAT THE ENDPOINTS ANSWER (apps/api/internal/campaigns/feedback.go:55-68):
 *
 *   GET   /api/v1/campaigns/{id}/feedback              read  → {items: [...]}
 *   POST  /api/v1/campaigns/{id}/feedback              write → the new row, 201
 *   PATCH /api/v1/campaigns/{id}/feedback/{fid}        write → the edited row
 *   POST  /api/v1/campaigns/{id}/feedback/{fid}/resolve write → the row, resolved
 *
 * A row is `{id, campaign_id, author_user_id?, author_label?, body,
 * resolved_at?, resolved_by?, created_at, updated_at}`. `resolved_at` is a
 * NULLABLE timestamp with `omitempty`, so "unresolved" arrives as an ABSENT
 * KEY, not as `null` — a `row.resolved_at === null` test would mark every open
 * comment resolved. That one line is most of why this file exists.
 *
 * WHY REORDER AT ALL. The server returns the thread newest-first
 * (`ListFeedback returns every comment for a campaign newest-first`). That is
 * the right order for a ledger and the wrong one for a review: the question a
 * phone reviewer has is "what is still open?", and on a small screen the answer
 * has to be at the top rather than three resolved comments down. So open
 * comments lead, resolved follow, and each group keeps the server's newest-first
 * order — a stable partition, not a re-sort.
 *
 * VALIDATION MIRRORS THE SERVER. The handler trims and rejects an empty body
 * (feedback.go:97-101) and decodes at most 16 KiB. Checking locally means the
 * reviewer is told before the round trip rather than after it.
 *
 * DELIBERATELY IMPORT-FREE, so it is testable in the node vitest environment.
 */

/**
 * Character cap for a comment. The server's limit is a 16 KiB JSON *body*;
 * this is a comfortable margin inside it once escaping is accounted for, and
 * it is a review note, not a document.
 */
export const FEEDBACK_MAX_CHARS = 4000;

export interface FeedbackWire {
  id?: unknown;
  author_label?: unknown;
  author_user_id?: unknown;
  body?: unknown;
  resolved_at?: unknown;
  resolved_by?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

export interface FeedbackListWire {
  items?: unknown;
}

export interface FeedbackRow {
  id: string;
  /** Display name for the author; falls back to a neutral label. */
  author: string;
  body: string;
  resolved: boolean;
  /** Epoch ms, or null when unparseable. */
  createdAt: number | null;
  resolvedAt: number | null;
}

export interface FeedbackThread {
  rows: FeedbackRow[];
  openCount: number;
  resolvedCount: number;
  empty: boolean;
}

export const EMPTY_FEEDBACK_THREAD: FeedbackThread = {
  rows: [],
  openCount: 0,
  resolvedCount: 0,
  empty: true,
};

function asTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * Resolved is "has a usable resolved_at", never "resolved_at is not null".
 *
 * `omitempty` on a `*time.Time` means an OPEN comment omits the key entirely,
 * and Go's zero time (`0001-01-01T00:00:00Z`) can appear when a nil pointer is
 * dereferenced upstream — both must read as open.
 */
export function isFeedbackResolved(row: FeedbackWire): boolean {
  const ms = asTimestamp(row.resolved_at);
  if (ms === null) return false;
  // Anything before 1971 is not a resolution; it is a zero value that escaped.
  return ms > 0;
}

export function readFeedbackThread(
  body: FeedbackListWire | null | undefined,
): FeedbackThread {
  const items = Array.isArray(body?.items) ? (body.items as FeedbackWire[]) : [];
  const open: FeedbackRow[] = [];
  const resolved: FeedbackRow[] = [];

  for (const raw of items) {
    if (raw == null || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const text = typeof raw.body === "string" ? raw.body.trim() : "";
    // Without an id the row cannot be resolved or edited, and without a body
    // there is nothing to read — either way it is not a comment.
    if (!id || !text) continue;
    const label =
      typeof raw.author_label === "string" && raw.author_label.trim()
        ? raw.author_label.trim()
        : "Someone in this workspace";
    const isResolved = isFeedbackResolved(raw);
    const row: FeedbackRow = {
      id,
      author: label,
      body:
        text.length > FEEDBACK_MAX_CHARS
          ? `${text.slice(0, FEEDBACK_MAX_CHARS)}…`
          : text,
      resolved: isResolved,
      createdAt: asTimestamp(raw.created_at),
      resolvedAt: isResolved ? asTimestamp(raw.resolved_at) : null,
    };
    (isResolved ? resolved : open).push(row);
  }

  const rows = [...open, ...resolved];
  return {
    rows,
    openCount: open.length,
    resolvedCount: resolved.length,
    empty: rows.length === 0,
  };
}

/**
 * The problem with a draft comment, or null when it is sendable.
 *
 * Returns the sentence to SHOW, not a code: this is the only consumer, and a
 * code would be indirection with one branch.
 */
export function feedbackDraftProblem(draft: string): string | null {
  const trimmed = draft.trim();
  if (!trimmed) return "Write a comment before posting.";
  if (trimmed.length > FEEDBACK_MAX_CHARS) {
    return `Comments are limited to ${FEEDBACK_MAX_CHARS} characters. This one is ${trimmed.length}.`;
  }
  return null;
}

/** Summary line for the thread's header and for the entry-point badge. */
export function feedbackSummary(thread: FeedbackThread): string {
  if (thread.empty) return "No comments yet";
  const parts: string[] = [];
  if (thread.openCount > 0) {
    parts.push(`${thread.openCount} open`);
  }
  if (thread.resolvedCount > 0) {
    parts.push(`${thread.resolvedCount} resolved`);
  }
  return parts.join(" · ");
}
