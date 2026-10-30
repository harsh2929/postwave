/**
 * api/eventReplayPlan.ts — the pure planner for realtime gap recovery.
 *
 * The server closes every SSE stream after five minutes (`:bye max-duration`,
 * apps/api/internal/events/handler.go) and the phone drops the socket whenever
 * it backgrounds or loses signal. Every event published inside those windows
 * was previously lost forever: mobile tracked no cursor at all, so the cache
 * kept serving stale rows with no indication (NATIVE#8).
 *
 * `GET /api/v1/events/replay?since=<sequence>&limit=<n>` returns
 * `{events, next_cursor, has_more}` from the tenant's retained (7 day)
 * append-only log, which is exactly the recovery primitive needed.
 *
 * Server behaviours this planner is written around:
 *
 *   1. FIXED 2026-08-04 — topic filtering used to happen AFTER the SQL `LIMIT`
 *      with `next_cursor` advancing only over MATCHING rows, so `?topics=` made
 *      the cursor non-monotonic and silently dropped events. `replayPage` in
 *      apps/api/internal/events/log.go now advances past every row EXAMINED and
 *      derives `has_more` from the scanned count, so the filter is safe to send.
 *      This client still omits it — not for correctness now, but because the
 *      local `queryRootsForEvent` filter is coarser than any topic list we
 *      could send, and a cellular client re-requesting on a narrower filter
 *      would miss roots it does map. Revisit together, not separately.
 *
 *   2. `has_more` is `len(scanned) == limit`, so the walk must also stop when
 *      the cursor stops advancing — otherwise a mis-shaped page loops.
 *
 *   3. `next_cursor` may be `null` (never `0`) when a page has no sequence
 *      cursor to give. See `parseEventReplayPage`.
 */

/** Page size for a normal gap walk. Small pages keep cellular responses lean. */
export const EVENT_REPLAY_PAGE_LIMIT = 200;
/**
 * Page size for the one-time cursor-discovery walk. Larger, because discovery
 * dispatches nothing and only wants to reach the head in as few round trips as
 * possible.
 */
export const EVENT_REPLAY_DISCOVERY_LIMIT = 500;
/** Hard ceiling on requests per gap walk, so a long gap cannot stall startup. */
export const EVENT_REPLAY_MAX_PAGES = 5;
/**
 * Hard ceiling on the discovery walk. A workspace with more retained events
 * than this simply keeps a behind-the-head cursor; the next walk advances it
 * further. Bounded cost matters more than instant convergence here.
 */
export const EVENT_REPLAY_DISCOVERY_MAX_PAGES = 2;

/** A single row of the retained event log. */
export interface ReplayedEvent {
  sequenceId: number;
  topic: string;
  at: string;
  payload?: Record<string, unknown>;
}

export interface EventReplayPage {
  events: ReplayedEvent[];
  nextCursor: number;
  hasMore: boolean;
}

export type ReplayStopReason =
  | "caught-up"
  | "page-budget"
  | "cursor-stalled"
  | "malformed";

export interface ReplayStep {
  /** Cursor to persist after this page. Never moves backwards. */
  cursor: number;
  /** Stop walking? */
  done: boolean;
  /** Why we stopped (only meaningful when `done`). */
  reason: ReplayStopReason | null;
}

/**
 * Build the replay request path. `topics` is intentionally absent — see the
 * module header.
 */
export function buildEventReplayPath(cursor: number, limit: number): string {
  const since = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
  const safeLimit = Math.min(
    500,
    Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 1),
  );
  return `/api/v1/events/replay?since=${since}&limit=${safeLimit}`;
}

function toReplayedEvent(raw: unknown): ReplayedEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.topic !== "string" || !row.topic) return null;
  const sequenceId =
    typeof row.sequence_id === "number" && Number.isFinite(row.sequence_id)
      ? row.sequence_id
      : 0;
  const at = typeof row.at === "string" ? row.at : "";
  const payload =
    row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : undefined;
  return {
    sequenceId,
    topic: row.topic,
    at,
    ...(payload ? { payload } : {}),
  };
}

/**
 * Validate + normalise one replay response. Returns null for a body that is
 * not a replay page at all (so the caller stops rather than guessing).
 */
export function parseEventReplayPage(raw: unknown): EventReplayPage | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.events)) return null;
  // `null` is a VALUE here, not a missing field: the gateway answers it when a
  // page has no sequence cursor to hand back (an empty log, or a time-mode
  // request). It used to answer `0`, which the web client folded in and then
  // resumed from — `sequence_id > 0` is the oldest page of the entire retained
  // log, re-requested on every reconnect. Treating the null as malformed would
  // turn an ordinary "caught up" into an abort, so it maps to "no forward
  // progress" and lets `planNextReplayStep` reach its normal terminal states.
  const nextCursor =
    typeof body.next_cursor === "number" && Number.isFinite(body.next_cursor)
      ? Math.max(0, Math.floor(body.next_cursor))
      : body.next_cursor === null
        ? 0
        : null;
  if (nextCursor === null) return null;
  const events: ReplayedEvent[] = [];
  for (const row of body.events) {
    const parsed = toReplayedEvent(row);
    if (parsed) events.push(parsed);
  }
  return { events, nextCursor, hasMore: body.has_more === true };
}

/**
 * Decide whether to request another page after `page`.
 *
 * `pageIndex` is zero-based. The cursor returned is monotonic: a server that
 * reports a lower `next_cursor` than we already hold never rewinds us into
 * re-dispatching history.
 */
export function planNextReplayStep(input: {
  previousCursor: number;
  pageIndex: number;
  page: EventReplayPage | null;
  maxPages: number;
}): ReplayStep {
  const { previousCursor, pageIndex, page, maxPages } = input;
  if (!page) {
    return { cursor: previousCursor, done: true, reason: "malformed" };
  }
  const cursor = Math.max(previousCursor, page.nextCursor);
  if (!page.hasMore) return { cursor, done: true, reason: "caught-up" };
  if (cursor <= previousCursor) {
    // The server says there is more but gave us no forward progress; walking
    // again would re-request the identical window forever.
    return { cursor, done: true, reason: "cursor-stalled" };
  }
  if (pageIndex + 1 >= Math.max(1, maxPages)) {
    return { cursor, done: true, reason: "page-budget" };
  }
  return { cursor, done: false, reason: null };
}
