/**
 * lib/auditTail.ts — the arithmetic and the copy behind the audit log's
 * "N new events" affordance. Import-free so it is node-testable; the query
 * that feeds it lives in hooks/useAuditTail.
 *
 * ── WHY A COUNTER AND NOT A PREPENDING STREAM ──────────────────────────────
 * This file used to say the app could not consume `GET /api/v1/audit/stream`
 * at all, because "React Native's fetch has no streaming body and there is no
 * EventSource". Half of that is true and it is the wrong half: RN's GLOBAL
 * fetch really has no streaming body, but this app streams through
 * `expo/fetch`, which does — the event bus has read a stream that way on every
 * launch since before this comment was written (see api/sseConnect). There is
 * still no EventSource; we decode frames ourselves.
 *
 * The counter survives the correction, because it was never really about the
 * transport. AUTO-PREPENDING MOVES THE LIST UNDER THE READER'S THUMB, and on a
 * phone that is how you lose the row you were reading in the middle of an
 * incident. So the design is unchanged: count, announce, and insert only on a
 * deliberate tap.
 *
 * What the stream IS used for is freshness. While the tail is on, the SSE
 * connection acts as a TRIGGER for the probe below rather than as a source of
 * rows — see hooks/useAuditTail. It has to be a trigger and not a count: the
 * server's stream is tenant-wide and knows nothing about the actor/window
 * filters the screen is applying, so a frame means "something happened", never
 * "something you are looking at happened". The probe is what knows.
 */

/** How often the tail asks. Slow enough to be cheap, fast enough to feel live. */
export const AUDIT_TAIL_INTERVAL_MS = 20_000;

/**
 * The probe window. Anything past this is reported as "50+" rather than an
 * invented number — the probe genuinely cannot see further, and a compliance
 * surface must not round a bound up into a fact.
 */
export const AUDIT_TAIL_PROBE_LIMIT = 50;

export interface AuditTailState {
  /** New rows seen since the newest rendered row, capped at the probe limit. */
  count: number;
  /** True when the probe filled its page, so `count` is a lower bound. */
  atLeast: boolean;
  /** True when the tail is actually running (on, online, something to compare). */
  live: boolean;
}

/**
 * Count rows newer than `newestId` in a probe page.
 *
 * `id` is the comparison key rather than `at`: the list is `ORDER BY id DESC`
 * (apps/api/internal/handlers/audit.go:176) and ids are monotonic, whereas
 * two rows can share a timestamp and a clock can go backwards. Strictly
 * greater-than, because the newest row already on screen is not new.
 *
 * A null `newestId` means nothing is loaded to compare against, which is 0
 * new events — NOT "everything is new".
 */
export function countNewerRows(
  rows: readonly { id?: number | null }[],
  newestId: number | null,
): number {
  if (newestId === null || !Number.isFinite(newestId)) return 0;
  let n = 0;
  for (const row of rows) {
    if (typeof row?.id === "number" && row.id > newestId) n += 1;
  }
  return n;
}

/** Highest id among the rendered rows, or null when there are none. */
export function newestAuditId(
  rows: readonly { id?: number | null }[],
): number | null {
  let out: number | null = null;
  for (const row of rows) {
    const id = row?.id;
    if (typeof id !== "number" || !Number.isFinite(id)) continue;
    if (out === null || id > out) out = id;
  }
  return out;
}

/** The pill's copy, or null when there is nothing new to announce. */
export function auditTailLabel(state: AuditTailState): string | null {
  if (!state.live || state.count <= 0) return null;
  const noun = state.count === 1 ? "new event" : "new events";
  return state.atLeast
    ? `${AUDIT_TAIL_PROBE_LIMIT}+ ${noun} — tap to load`
    : `${state.count} ${noun} — tap to load`;
}

/**
 * The sentence under the Live toggle.
 *
 * It names the POLL cadence deliberately, even though a connected stream
 * re-checks far sooner: the poll is the only cadence that is guaranteed, and a
 * promise the operator only sometimes gets is worse than a floor they always
 * do. The "counted, not inserted" half is the part they must never be
 * surprised by — an operator who believes they are watching an auto-inserting
 * feed will read a quiet twenty seconds as "nothing happened".
 */
export function auditTailExplanation(live: boolean): string {
  return live
    ? `Checking for new events every ${Math.round(AUDIT_TAIL_INTERVAL_MS / 1000)}s. New rows are counted, not inserted — tap the banner to load them.`
    : "Live off. Pull down to refresh, or turn Live on to be told when new events arrive.";
}

/**
 * The floor between two stream-triggered re-checks.
 *
 * The audit stream emits one frame PER ROW, and a busy tenant can produce them
 * continuously — so a re-check per frame would turn the cheapest tail in the
 * product into the most expensive read in it, firing many times a second. Three
 * seconds keeps the felt latency far below the 20s poll while putting a hard
 * ceiling on request rate.
 */
export const AUDIT_TAIL_STREAM_MIN_REFRESH_MS = 3_000;

/**
 * How long to wait before acting on a stream frame, given when we last acted.
 *
 * 0 means "now". A positive number is the remaining cooldown, so a burst of
 * frames collapses into ONE re-check at the end of it rather than one per
 * frame. `lastRefreshAt` of null means we have never re-checked, which is not
 * a cooldown.
 */
export function auditTailStreamRefreshDelay(
  lastRefreshAt: number | null,
  now: number,
  minIntervalMs: number = AUDIT_TAIL_STREAM_MIN_REFRESH_MS,
): number {
  if (lastRefreshAt === null || !Number.isFinite(lastRefreshAt)) return 0;
  // A clock that went backwards must not produce a delay longer than the
  // cooldown itself (or, worse, a negative timeout).
  const elapsed = Math.max(0, now - lastRefreshAt);
  return elapsed >= minIntervalMs ? 0 : minIntervalMs - elapsed;
}

/**
 * Classify one frame from `GET /api/v1/audit/stream`.
 *
 * The wire is `event: hello` once at connect (a cursor seed, not a row) and
 * `event: audit` per row thereafter, plus `: heartbeat` comments the parser
 * never surfaces as frames. Only `audit` means something happened.
 */
export function isAuditStreamRowFrame(frame: { event: string }): boolean {
  return frame.event.trim() === "audit";
}

/**
 * Actions the tail must never re-fire on — because the tail WROTE them.
 *
 * ── THE FEEDBACK LOOP THIS CLOSES ──────────────────────────────────────────
 * Every read of the audit surface is itself audited. `GET /api/v1/audit` is
 * mounted `With(gates.raw, gates.meta(middleware.AuditReadList))`
 * (apps/api/internal/server/audit_operations.go), and AuditMetaMiddleware
 * writes an `audit.read.list` row on every 2xx, with no dedupe
 * (internal/middleware/audit_meta.go). Opening the stream writes
 * `audit.read.stream_open` the same way.
 *
 * The stream's own row query has NO action filter — `WHERE tenant_id = $1 AND
 * id > $2` (internal/handlers/audit_extras.go) — so it re-emits those rows. If
 * the client classifies on the event NAME alone, the probe's own meta-row
 * arrives back as `event: audit`, re-fires the probe, and the tail settles into
 * one request every AUDIT_TAIL_STREAM_MIN_REFRESH_MS forever on a completely
 * idle tenant, each one growing the compliance table it is reading.
 *
 * The server already knows these rows are noise: audit.go's
 * `defaultAuditReadExclusionSQL` is
 * `(action NOT LIKE 'audit.read.%' AND action NOT LIKE 'http.%')` and hides
 * them from the default list. The list the operator sees therefore never
 * counts them either — so acting on them could only ever produce a request,
 * never a number. Applying the same predicate here is the client half.
 */
export const AUDIT_STREAM_IGNORED_ACTION_PREFIXES = [
  "audit.read.",
  "http.",
] as const;

/**
 * The `action` of one `event: audit` frame, or null when it cannot be read.
 *
 * The wire is `data: <AuditRow JSON>` and AuditRow marshals `action` as a
 * non-omitempty string (apps/api/internal/handlers/audit.go), so null here
 * means the payload shape drifted, not that a row lacks an action.
 */
export function auditStreamFrameAction(data: string): string | null {
  const text = data.trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const action = (parsed as { action?: unknown }).action;
  return typeof action === "string" && action.trim() ? action.trim() : null;
}

/** True when this action is one the audit surface's own reads generate. */
export function isSelfInflictedAuditAction(action: string): boolean {
  return AUDIT_STREAM_IGNORED_ACTION_PREFIXES.some((prefix) =>
    action.startsWith(prefix),
  );
}

/**
 * Should this frame re-run the probe?
 *
 * `hello` (the cursor seed) never does: it describes history, not an arrival.
 * A row whose action is one of OUR OWN reads never does either — see above.
 *
 * UNREADABLE PAYLOADS FAIL CLOSED. A frame whose action cannot be parsed is
 * not proof that it is not our own read, and the whole defect being fixed here
 * is a self-sustaining request loop. Failing closed costs freshness only: the
 * 20s poll is untouched and remains the guaranteed cadence, so the worst case
 * of a future payload-shape drift is the tail behaving exactly as it did
 * before the stream existed. Failing open would re-open the loop.
 */
export function auditStreamFrameTriggersProbe(frame: {
  event: string;
  data: string;
}): boolean {
  if (!isAuditStreamRowFrame(frame)) return false;
  const action = auditStreamFrameAction(frame.data);
  if (action === null) return false;
  return !isSelfInflictedAuditAction(action);
}
