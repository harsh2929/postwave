/**
 * lib/streamingExportRuns.ts — parsing streaming-export shipment history.
 *
 * WHAT THIS ANSWERS. A streaming-export destination is a warehouse connection
 * with `provider = "streaming_export"`; instead of a nightly batch it ships
 * bounded WINDOWS of subscriber events on a cadence. The warehouse-runs screen
 * already answers "did last night's batch land" for the batch providers; this
 * module answers the same question for the streaming ones — "did the newest
 * window ship, and if not, how far behind are we" — because a streaming
 * failure has exactly the same cost shape (silent, and paid for in the hours
 * before somebody notices).
 *
 * THE SHAPE, READ OFF THE GO SOURCE (not a doc):
 *   - `Run`               apps/api/internal/streaming_export/streaming_export.go:99-119
 *   - `ListRuns` handler  streaming_export.go:371-391 — writes
 *                         `{ items: sanitizeRuns(runs), last_shipped_at }`
 *   - `sanitizeRun`       streaming_export.go:475-484 — blanks `object_uri` and
 *                         `error` and sets `issue_present = error != ""`.
 *                         The phone therefore NEVER receives the failure text;
 *                         it receives the fact that there was one.
 *   - the CHECK constraint infra/migrations/1100_streaming_export_config.sql:57
 *     `status IN ('running','completed','failed','empty')`
 *   - `last_shipped_at`   repo.go:154-162 — max(window_end) over runs that are
 *                         completed/empty AND has_more = false, i.e. the last
 *                         window the connection is genuinely CAUGHT UP to.
 *
 * COUNTERS. `beginRun` (repo.go:292) inserts the row as `running` with the
 * column-default 0 for rows/bytes; `completeRun` (repo.go:315-330) writes the
 * real figures for `completed`, explicit zeros for `empty` ("no due events")
 * and — via `failRun` (worker.go:236) — explicit zeros for `failed` ("nothing
 * shipped"). So unlike the batch ledger, a 0 on a FAILED streaming run is a
 * measurement; only a RUNNING run's 0 means "not yet measured".
 *
 * DELIBERATELY IMPORT-FREE of react-native so it runs under node vitest.
 *
 * WHAT IS NOT HERE. Judging a connection or the roster from these parsed
 * histories — the per-connection verdict, the dock strip's sentence, the
 * roster⇄reads join and the refused-read sentences — lives in
 * `lib/streamingExportVerdict.ts`, split off by responsibility so each half
 * stays under the 450-line source ceiling.
 */
import { EMDASH, bytes, num, plural } from "@/lib/format";
import { transitionLabel } from "@/lib/direction";

/** `warehouse_connections.provider` for a streaming destination. */
export const STREAMING_EXPORT_PROVIDER = "streaming_export";

/**
 * The role this section gates on BEFORE issuing a request.
 *
 * The generated manifest row for `GET /connections/{id}/streaming/runs` is
 * `session_minimum_role: viewer` (apps/api/internal/routeauth/manifest.json),
 * as is every other warehouse READ today. The host screen, however, still
 * gates the whole surface at admin (see the note at the top of
 * `components/warehouse/WarehouseRunsScreen.tsx`), and a section of a screen
 * must not be looser than the screen it sits on — a viewer would otherwise
 * see "needs an owner or admin session" with a streaming dock underneath it.
 * Relax this in step with the host screen, never on its own.
 */
export const STREAMING_EXPORT_RUNS_MINIMUM_ROLE = "admin";

/** The CHECK-constrained vocabulary, plus the honest fallback. */
export type StreamingRunOutcome =
  | "completed"
  | "empty"
  | "failed"
  | "running"
  | "unknown";

export interface StreamingExportRun {
  id: string;
  connectionId: string;
  /** The server's own word, never re-spelled. */
  status: string;
  outcome: StreamingRunOutcome;
  format: string;
  compression: string;
  windowStart: string;
  windowEnd: string;
  cursorFrom: number;
  cursorTo: number;
  /** The batch cap was hit inside this window: more events are due. */
  hasMore: boolean;
  rowsShipped: number;
  bytesShipped: number;
  /** The server recorded a failure message it does not show the phone. */
  issuePresent: boolean;
  startedAt: string;
  completedAt: string;
  createdAt: string;
  durationMs: number | null;
  terminal: boolean;
  /** rows/bytes carry a measurement — see the module note. */
  countersMeasured: boolean;
  /** The row an operator has to act on: `failed`, or an issue was recorded. */
  failed: boolean;
}

export interface StreamingExportHistory {
  /** Newest first, exactly as `ORDER BY created_at DESC` returned. */
  runs: StreamingExportRun[];
  /** "" when nothing has shipped — the server writes `null`. */
  lastShippedAt: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function streamingRunOutcomeOf(status: string): StreamingRunOutcome {
  switch (status.trim().toLowerCase()) {
    case "completed":
      return "completed";
    case "empty":
      return "empty";
    case "failed":
      return "failed";
    case "running":
      return "running";
    default:
      return "unknown";
  }
}

function durationBetween(startedAt: string, completedAt: string): number | null {
  if (!startedAt || !completedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const delta = end - start;
  return delta >= 0 ? delta : null;
}

export function normalizeStreamingExportRun(raw: unknown): StreamingExportRun {
  const row = record(raw);
  const status = str(row.status);
  const outcome = streamingRunOutcomeOf(status);
  const startedAt = str(row.started_at);
  const completedAt = str(row.completed_at);
  const terminal =
    outcome === "completed" || outcome === "empty" || outcome === "failed";
  const issuePresent = row.issue_present === true;
  return {
    id: str(row.id),
    connectionId: str(row.connection_id),
    status,
    outcome,
    format: str(row.format),
    compression: str(row.compression),
    windowStart: str(row.window_start),
    windowEnd: str(row.window_end),
    cursorFrom: int(row.cursor_from),
    cursorTo: int(row.cursor_to),
    hasMore: row.has_more === true,
    rowsShipped: int(row.rows_shipped),
    bytesShipped: int(row.bytes_shipped),
    issuePresent,
    startedAt,
    completedAt,
    createdAt: str(row.created_at),
    durationMs: durationBetween(startedAt, completedAt),
    terminal,
    countersMeasured: terminal,
    failed: outcome === "failed" || issuePresent,
  };
}

/**
 * `{ items, last_shipped_at }` as `ListRuns` writes it. `items` is defended
 * against `null` even though the handler always writes an array, because a
 * proxy or an older server is one deploy away, and a null must read as "no
 * records" rather than crash the tab.
 */
export function normalizeStreamingExportHistory(
  raw: unknown,
): StreamingExportHistory {
  const body = record(raw);
  const items = Array.isArray(body.items) ? body.items : [];
  return {
    runs: items.map(normalizeStreamingExportRun).filter((run) => run.id !== ""),
    lastShippedAt: str(body.last_shipped_at),
  };
}

export function isStreamingExportConnection(connection: {
  provider: string;
}): boolean {
  return connection.provider.trim().toLowerCase() === STREAMING_EXPORT_PROVIDER;
}

export type StreamingRunTone =
  | "success"
  | "danger"
  | "neutral"
  | "info"
  | "warning";

const OUTCOME_TONE: Readonly<Record<StreamingRunOutcome, StreamingRunTone>> = {
  completed: "success",
  empty: "neutral",
  failed: "danger",
  running: "info",
  unknown: "warning",
};

/** Desktop copy, verbatim (StreamingExportStatus.tsx:659). */
export const STREAMING_ISSUE_HIDDEN =
  "Issue evidence recorded; private details are hidden";

/**
 * One run, reduced to what a list row says. Dates are left as ISO strings
 * because formatting them is locale work for the component; everything that
 * is a JUDGEMENT (tone, what the detail line says, whether 0 is a count) is
 * decided here so it is decided once and tested under node.
 */
export interface StreamingRunRowModel {
  id: string;
  status: string;
  tone: StreamingRunTone;
  /** An issue was recorded on a run whose status is not `failed`. */
  issueFlag: boolean;
  /** The cursor window, or the issue sentence when the run did not land. */
  detail: string;
  /** What the window moved, or why there is no figure. */
  shipped: string;
  windowEnd: string;
  durationMs: number | null;
}

export function streamingRunRowModel(
  run: StreamingExportRun,
): StreamingRunRowModel {
  const detail = run.failed
    ? STREAMING_ISSUE_HIDDEN
    : `cursor ${transitionLabel(num(run.cursorFrom), num(run.cursorTo))} · ${
        run.hasMore ? "more due" : "caught up"
      }`;
  let shipped: string;
  if (!run.countersMeasured) {
    shipped = `${EMDASH} not yet measured`;
  } else if (run.outcome === "failed") {
    shipped = "nothing shipped";
  } else if (run.outcome === "empty" || run.rowsShipped === 0) {
    shipped = "no due events";
  } else {
    shipped = `${plural(run.rowsShipped, "row")} · ${bytes(run.bytesShipped)}`;
  }
  return {
    id: run.id,
    status: run.status || "unknown",
    tone: OUTCOME_TONE[run.outcome],
    issueFlag: run.issuePresent && run.outcome !== "failed",
    detail,
    shipped,
    windowEnd: run.windowEnd,
    durationMs: run.durationMs,
  };
}
