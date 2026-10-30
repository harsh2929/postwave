/**
 * Gap recovery for the realtime event stream.
 *
 * THE PROBLEM
 *
 * SSE has no redelivery. A client that loses its connection — a closed lid, a
 * tunnel, a backgrounded app — misses every event published while it was away
 * and only notices when some query's `staleTime` happens to expire. Nothing
 * logs, nothing retries, and the UI is quietly wrong until the user reloads.
 *
 * The server has had `GET /api/v1/events/replay` the whole time. No client
 * called it.
 *
 * WHY THE CURSOR IS A TIMESTAMP
 *
 * The natural cursor is `event_log.sequence_id`, and replayed rows carry it.
 * The LIVE stream cannot: `LogWriter.OnPublish` is a best-effort hook whose
 * errors are deliberately swallowed so a log failure cannot take the stream
 * down with it, which means a live event is fanned out without ever learning
 * its sequence id. Attaching one would couple SSE delivery to the health of a
 * write the server has decided may fail.
 *
 * So a client that was streaming resumes by TIME, and the server's time replay
 * is inclusive — at-least-once. That is the right trade here: every consumer of
 * this stream is cache invalidation, which is idempotent, so a duplicate costs
 * one redundant refetch and a miss costs permanently stale data.
 *
 * This module is pure. Each client owns its transport and its reconnect
 * lifecycle; all three share these rules so a cursor cannot mean three things.
 */

import { usableEventTopicFilters } from "./events.js";

export const REPLAY_PATH = "/api/v1/events/replay";

/** The server's own maximum; asking for more is silently clamped there. */
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;

export interface ReplayCursor {
  /** Newest event timestamp seen, RFC 3339. The stream-resume cursor. */
  sinceAt: string | null;
  /** Newest `sequence_id` seen. Only replayed rows carry one. */
  sequenceId: number | null;
}

/** The subset of a wire event this module reads. */
export interface ReplayCursorSource {
  ts?: unknown;
  sequence_id?: unknown;
}

export interface ReplayPage {
  /** Wire events, in the SAME shape the live stream emits. */
  events: Record<string, unknown>[];
  cursor: ReplayCursor;
  hasMore: boolean;
}

export const EMPTY_REPLAY_CURSOR: ReplayCursor = {
  sinceAt: null,
  sequenceId: null,
};

function parsedTime(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * A value usable as a `since=` sequence cursor, or null.
 *
 * ONE definition, used by both the event fold and the page parse. It had two,
 * and only the parse side was strict — so a hostile or buggy `sequence_id` on
 * an EVENT bypassed rules the same module applies to `next_cursor`:
 *
 *   since=1.5   the gateway 400s on a non-integer, so every later recovery is
 *               rejected and the client stalls permanently with nothing said
 *   since=0     `sequence_id > 0` means the very start of the retained log —
 *               a full replay that invalidates every cache
 *   since=-7    same, and not a cursor the server ever mints
 *
 * Those consequences are quoted from this file's own comments; they were
 * already understood, just enforced on one of the two paths that can set the
 * cursor — and the unguarded one is the primary path, since it folds every
 * live and replayed event.
 */
function usableSequenceId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/**
 * Fold one event into the cursor.
 *
 * MONOTONIC in both fields. Events can arrive out of order around a reconnect,
 * and a cursor that regressed would replay an already-processed window — then,
 * worse, advance from the regressed point and skip the real gap.
 */
export function advanceReplayCursor(
  cursor: ReplayCursor,
  event: ReplayCursorSource,
): ReplayCursor {
  let { sinceAt, sequenceId } = cursor;

  const incoming = parsedTime(event.ts);
  if (incoming !== null) {
    const current = parsedTime(sinceAt);
    if (current === null || incoming > current) sinceAt = event.ts as string;
  }

  const incomingSequence = usableSequenceId(event.sequence_id);
  if (incomingSequence !== null) {
    if (sequenceId === null || incomingSequence > sequenceId) {
      sequenceId = incomingSequence;
    }
  } else if (sinceAt !== cursor.sinceAt) {
    // A LIVE event advanced the clock and carries no sequence id — the wire
    // shape has never had one. Keeping the old sequence cursor would pin every
    // future reconnect to a point the stream has long since passed, so the
    // client would replay the window it just watched live instead of the gap.
    // Replayed rows DO carry a sequence id and take the branch above, so a walk
    // in progress keeps paginating exactly.
    sequenceId = null;
  }

  return sinceAt === cursor.sinceAt && sequenceId === cursor.sequenceId
    ? cursor
    : { sinceAt, sequenceId };
}

/**
 * The replay URL for a cursor, or null when there is nothing to recover.
 *
 * Null matters: a client with no cursor has never seen an event, so replaying
 * from zero would deliver the entire retained log and invalidate every cache
 * for no benefit. A first connection is not a gap.
 *
 * Exactly one cursor is sent. The sequence cursor is preferred when known — it
 * is exact, where time replay is inclusive and therefore returns the boundary
 * event again.
 */
export function replayRequestPath(
  cursor: ReplayCursor,
  topics: readonly string[],
  opts: { limit?: number; skewGraceMs?: number } = {},
): string | null {
  // Built by hand rather than with URLSearchParams: this package targets the
  // shared lib DOM-free, and every value here is already constrained (a number,
  // an RFC 3339 timestamp, and topics filtered by the gateway's own grammar).
  const params: string[] = [];
  if (cursor.sequenceId !== null) {
    params.push(`since=${encodeURIComponent(String(cursor.sequenceId))}`);
  } else if (cursor.sinceAt !== null) {
    // `at` is stamped by whichever replica published the event, so a row
    // written by a lagging replica can land BEHIND a cursor advanced from a
    // leading one and be missed permanently — no later page covers it, because
    // the window has already moved past. Widening by the grace re-reads a few
    // seconds; replay is idempotent, so that costs nothing. Sequence ids come
    // from the database and have no skew to absorb, which is why this only
    // applies to the time branch.
    const grace = Math.max(0, Math.floor(opts.skewGraceMs ?? 0));
    const parsed = grace > 0 ? parsedTime(cursor.sinceAt) : null;
    const value =
      parsed === null ? cursor.sinceAt : new Date(parsed - grace).toISOString();
    params.push(`since_at=${encodeURIComponent(value)}`);
  } else {
    return null;
  }

  // Send only filters the gateway accepts, under the SAME bounds the stream
  // uses. An invalid entry is dropped there silently, so a client that sent
  // one would replay a WIDER set than it subscribes to. An OVERSIZED list is
  // worse: the gateway substitutes its no-match sentinel, so every page comes
  // back empty while the cursor advances and the gap is skipped rather than
  // recovered. `null` means "omit the filter" — replay everything, which is a
  // correct if noisy answer, where a silently-empty replay is not.
  const usable = usableEventTopicFilters(topics);
  if (usable !== null) {
    params.push(`topics=${encodeURIComponent(usable.join(","))}`);
  }

  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)),
    MAX_LIMIT,
  );
  params.push(`limit=${limit}`);

  // `,` and `:` come back percent-encoded; both are legal in a query value and
  // the server decodes them, so the round-trip is unaffected.
  return `${REPLAY_PATH}?${params.join("&")}`;
}

function isUsableEvent(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).topic === "string"
  );
}

/**
 * Read a replay page defensively.
 *
 * A malformed body yields an EMPTY page rather than throwing. Replay runs on
 * the reconnect path: an exception there would take down the live subscription
 * as well, turning a recoverable gap into no realtime at all.
 */
export function parseReplayResponse(raw: unknown): ReplayPage {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { events: [], cursor: EMPTY_REPLAY_CURSOR, hasMore: false };
  }
  const body = raw as Record<string, unknown>;
  const events = Array.isArray(body.events)
    ? body.events.filter(isUsableEvent)
    : [];
  const sinceAt =
    typeof body.next_since_at === "string" && body.next_since_at !== ""
      ? body.next_since_at
      : null;
  // `> 0`, not just finite. The gateway clamps `next_cursor` to the caller's
  // own cursor, which is 0 for every time-mode request, so a page that scanned
  // nothing answers `next_cursor: 0` — and 0 as a sequence cursor means
  // `sequence_id > 0`, i.e. the very start of the retained log.
  // `isInteger`, not `isFinite`. The gateway now 400s on a non-integer `since`,
  // so folding a fractional cursor in would turn what used to be a silent
  // full-log replay into a silent permanent stall — every subsequent recovery
  // rejected, with nothing on the client saying so.
  const sequenceId = usableSequenceId(body.next_cursor);
  return {
    events,
    cursor: { sinceAt, sequenceId },
    hasMore: body.has_more === true,
  };
}
