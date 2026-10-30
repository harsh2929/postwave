/**
 * lib/auditSinkReplay.ts — parsing + policy for historical range replays on an
 * audit sink (apps/api/internal/auditsink/admin.go: Replay, ListReplayJobs,
 * CancelReplayJob; job shape in replay.go).
 *
 * THE RANGE IS AUDIT IDS, NOT TIMESTAMPS. `POST /{id}/replay` takes
 * `{from_id, to_id}` — the same ids every audit row and DLQ entry displays —
 * and the server caps one job at `MaxReplayRowsPerJob` (100,000 rows,
 * replay.go:60). Desktop's replay tab takes the ids as typed numbers
 * (AuditSinkReplayTab.tsx); mobile mirrors that rather than inventing a
 * time→id translation the server does not offer.
 *
 * CANCEL ONLY BITES `pending` OR `in_progress` — the UPDATE's WHERE clause
 * (replay.go:272) skips everything else and the handler answers 409. So the
 * cancel affordance is shown exactly for those two states: a cancel button on
 * a completed job is a control that can only teach "this does nothing".
 *
 * Import-free of react-native; asserted under node vitest.
 */

import { num as formatNum } from "./format";

/** Server cap per job (auditsink/replay.go:60). */
export const MAX_REPLAY_ROWS_PER_JOB = 100_000;

export interface SinkReplayRange {
  fromId: number;
  toId: number;
}

/**
 * Mirror of the handler's refusals, in its own words: non-negative integers,
 * from <= to, and the span within the row cap. Empty errors = the server will
 * accept the range.
 */
export function validateReplayRange(
  fromRaw: string,
  toRaw: string,
): { range: SinkReplayRange | null; errors: string[] } {
  const errors: string[] = [];
  const fromId = parseId(fromRaw);
  const toId = parseId(toRaw);
  if (fromId === null || toId === null) {
    errors.push("Both ends of the range must be audit event ids (whole numbers).");
    return { range: null, errors };
  }
  if (fromId < 0 || toId < 0) {
    errors.push("Audit ids are never negative.");
  }
  if (fromId > toId) {
    errors.push("The range must run low to high — from_id must not exceed to_id.");
  }
  if (toId - fromId + 1 > MAX_REPLAY_ROWS_PER_JOB) {
    errors.push(
      `One job replays at most ${formatNum(MAX_REPLAY_ROWS_PER_JOB)} rows — split a bigger window into multiple jobs.`,
    );
  }
  return errors.length > 0 ? { range: null, errors } : { range: { fromId, toId }, errors };
}

function parseId(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

export interface SinkReplayJob {
  id: string;
  fromAuditId: number;
  toAuditId: number;
  status: string;
  rowsSent: number;
  rowsFailed: number;
  lastError: string;
  createdAt: string | null;
  completedAt: string | null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function timestamp(value: unknown): string | null {
  const raw = str(value);
  if (!raw || raw.startsWith("0001-01-01")) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

export function parseSinkReplayJob(value: unknown): SinkReplayJob | null {
  const row = (value ?? {}) as Record<string, unknown>;
  const id = str(row["id"]);
  if (!id) return null;
  return {
    id,
    fromAuditId: num(row["from_audit_id"]),
    toAuditId: num(row["to_audit_id"]),
    status: str(row["status"]) || "pending",
    rowsSent: num(row["rows_sent"]),
    rowsFailed: num(row["rows_failed"]),
    lastError: str(row["last_error"]),
    createdAt: timestamp(row["created_at"]),
    completedAt: timestamp(row["completed_at"]),
  };
}

export interface SinkReplayJobPage {
  jobs: SinkReplayJob[];
  /** The server withheld older jobs — say so rather than imply totality. */
  truncated: boolean;
}

export function parseSinkReplayJobPage(payload: unknown): SinkReplayJobPage {
  const body = (payload ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(body["jobs"]) ? body["jobs"] : [];
  return {
    jobs: raw
      .map(parseSinkReplayJob)
      .filter((job): job is SinkReplayJob => job !== null),
    truncated: typeof body["nextCursor"] === "string" && body["nextCursor"] !== "",
  };
}

/** The WHERE clause in CancelReplayJob bites only these two states. */
export function isReplayJobCancellable(job: SinkReplayJob): boolean {
  return job.status === "pending" || job.status === "in_progress";
}

/** One sentence per job — state first, then the range, then the counts. */
export function replayJobLine(job: SinkReplayJob): string {
  const range = `${formatNum(job.fromAuditId)}–${formatNum(job.toAuditId)}`;
  switch (job.status) {
    case "pending":
      return `Queued · rows ${range}`;
    case "in_progress":
      return `Replaying rows ${range} · ${formatNum(job.rowsSent)} sent${
        job.rowsFailed > 0 ? `, ${formatNum(job.rowsFailed)} failed` : ""
      }`;
    case "completed":
      return `Completed · rows ${range} · ${formatNum(job.rowsSent)} sent${
        job.rowsFailed > 0 ? `, ${formatNum(job.rowsFailed)} failed` : ""
      }`;
    case "cancelled":
      return `Cancelled · rows ${range} · ${formatNum(job.rowsSent)} sent before the stop`;
    case "failed":
      return `Failed · rows ${range}${job.lastError ? ` · ${job.lastError}` : ""}`;
    default:
      return `${job.status} · rows ${range}`;
  }
}
