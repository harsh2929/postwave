/**
 * lib/auditExport.ts — the audit log's async export, as policy.
 *
 * WHY THE ASYNC JOB AND NOT A DOWNLOAD. Desktop calls GET /api/v1/audit/export
 * and streams a CSV straight into a file picker. That shape does not survive a
 * phone: the request can outlive the foreground, there is nowhere useful to put
 * a 40 MB file, and the operator's actual intent ("I want this evidence, I will
 * collect it later") is a JOB, not a download. The server already models it as
 * one — POST /api/v1/audit/export-async enqueues, GET /api/v1/audit/export-jobs
 * lists — so mobile gets the BETTER half of the feature, not a degraded copy.
 *
 * TWO HONESTY PROBLEMS THIS MODULE EXISTS TO SOLVE.
 *
 *  1. THE EXPORT IS NOT "THIS VIEW". The audit screen narrows on four things,
 *     and only two of them (the time window and a single-value actor chip) are
 *     server-side facets. The search box and the Destructive toggle have no
 *     server equivalent at all — they filter what has already been loaded. An
 *     "Export this view" button that silently drops them produces a CSV that
 *     does not match the screen it was launched from, which for an audit
 *     artefact is the worst possible failure. `auditExportScope` names exactly
 *     what will and will not be applied, in the UI, before the tap.
 *
 *  2. A QUEUED JOB MAY NEVER RUN. The export worker is registered behind a
 *     deployment flag (EnableAuditExport in workers/operational_maintenance.go)
 *     and the handler's own comment says the row "sits at status='pending'
 *     indefinitely" when no worker is running. A spinner that spins forever
 *     tells the operator the system is working. After AUDIT_EXPORT_STALL_MS a
 *     pending job is reported as STALLED instead — an honest "nothing has
 *     picked this up", which is actionable, rather than a lie that is not.
 *
 * DELIBERATELY IMPORT-FREE apart from lib/format (itself pure), so every rule
 * here is asserted in the node vitest environment — the hook and sheet that use
 * it both transitively import react-native and cannot be.
 */
import { bytes, num, plural, relativeTime } from "./format";

/** Wire statuses set by the server: see handlers/audit_export_worker.go. */
export type AuditExportStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

/** What the UI actually branches on. `stalled` is derived, not a wire value. */
export type AuditExportKind =
  | "queued"
  | "stalled"
  | "running"
  | "done"
  | "failed";

/** Mirrors handlers.AuditExportJob (Go, camelCase JSON tags). */
export interface AuditExportJob {
  id: string;
  status: AuditExportStatus | string;
  estimatedRows?: number | null;
  exportedRows?: number;
  totalBytes?: number;
  fileUrl?: string | null;
  errorReason?: string | null;
  emailOnComplete?: boolean;
  emailAddress?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  etaSeconds?: number | null;
}

/**
 * How long a job may sit at `pending` before the UI stops calling it "queued".
 *
 * Five minutes is comfortably longer than the worker's own poll interval, so a
 * healthy deployment never trips it, and short enough that an operator waiting
 * on evidence finds out inside a coffee break rather than never.
 */
export const AUDIT_EXPORT_STALL_MS = 5 * 60_000;

/** Newest-first cap for the history list — this is a preview, not an archive. */
export const AUDIT_EXPORT_HISTORY_LIMIT = 20;

/**
 * Server-side facets the export can honour, lifted straight from the screen's
 * own filter state. Deliberately NOT the search text or destructive toggle:
 * see the module header.
 */
export interface AuditExportScopeInput {
  /** Canonical wire actor_type, only when the chip maps to exactly one. */
  actorType?: string | undefined;
  /** RFC3339 lower bound, absent for the "All" window. */
  since?: string | undefined;
  /** Human name of the window, for the disclosure sentence. */
  windowDescription: string;
  /** Free-text search currently narrowing the loaded rows, if any. */
  query?: string | undefined;
  /** Whether the Destructive-only toggle is on. */
  destructiveOnly?: boolean | undefined;
  /**
   * Whether the Security lens is on. Like the Destructive toggle it is a
   * client-side keyword heuristic with no server facet, so it MUST be
   * disclosed as dropped — an export launched from a Security view that
   * silently returns the whole log is an audit artefact that disagrees with
   * the screen it came from.
   */
  securityOnly?: boolean | undefined;
  /**
   * Substring over the action key. A REAL server facet: exportAsyncReq
   * (handlers/audit_paging.go) accepts `action`, so it narrows the file.
   */
  action?: string | undefined;
  /** Exact resource type — also a real server facet of the export job. */
  resourceType?: string | undefined;
  /** Substring over the resource id — server facet. */
  resourceId?: string | undefined;
  /** Exact actor label — server facet. */
  actorLabel?: string | undefined;
}

export interface AuditExportScope {
  /** The request body for POST /api/v1/audit/export-async. */
  body: Record<string, string>;
  /** "Everything in the last 7 days, from agents." */
  applied: string;
  /**
   * The narrowing that will NOT be in the file, or null when the screen is not
   * narrowed client-side and there is therefore nothing to disclose.
   */
  dropped: string | null;
}

/**
 * Turn the screen's filter state into a request plus the two sentences the UI
 * must show beside the button.
 */
export function auditExportScope(input: AuditExportScopeInput): AuditExportScope {
  const body: Record<string, string> = {};
  if (input.actorType) body.actorType = input.actorType;
  if (input.since) body.since = input.since;
  // The advanced facets ride into the job: exportAsyncReq stores them in
  // filters_json and the worker applies them, so the CSV genuinely matches
  // the narrowed screen instead of silently widening back to the whole log.
  if (input.action) body.action = input.action;
  if (input.resourceType) body.resourceType = input.resourceType;
  if (input.resourceId) body.resourceId = input.resourceId;
  if (input.actorLabel) body.actorLabel = input.actorLabel;

  const serverFacets: string[] = [];
  if (input.actorType) serverFacets.push(`from ${input.actorType} actors`);
  if (input.action) serverFacets.push(`action contains “${input.action}”`);
  if (input.resourceType) {
    serverFacets.push(`resource type ${input.resourceType}`);
  }
  if (input.resourceId) {
    serverFacets.push(`resource id contains “${input.resourceId}”`);
  }
  if (input.actorLabel) serverFacets.push(`actor ${input.actorLabel}`);
  const applied =
    serverFacets.length > 0
      ? `Everything in ${input.windowDescription}, ${sentenceJoin(serverFacets)}.`
      : `Everything in ${input.windowDescription}.`;

  const dropped: string[] = [];
  if (input.query && input.query.trim()) {
    dropped.push(`the search for "${input.query.trim()}"`);
  }
  if (input.destructiveOnly) dropped.push("the Destructive-only toggle");
  if (input.securityOnly) dropped.push("the Security lens");
  return {
    body,
    applied,
    dropped:
      dropped.length > 0
        ? `${sentenceJoin(dropped)} ${
            dropped.length === 1 ? "is" : "are"
          } applied on this device only and will NOT narrow the file — the server has no facet for ${
            dropped.length === 1 ? "it" : "them"
          }.`
        : null,
  };
}

/** Oxford-free join: "a", "a and b", "a, b and c". */
function sentenceJoin(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The state the UI branches on. `now` is a parameter rather than Date.now() so
 * the stall boundary is testable and so a ticking screen re-derives it.
 */
export function auditExportKind(
  job: AuditExportJob,
  now = Date.now(),
): AuditExportKind {
  if (job.status === "completed") return "done";
  if (job.status === "failed") return "failed";
  if (job.status === "in_progress") return "running";
  const created = Date.parse(job.createdAt ?? "");
  if (Number.isFinite(created) && now - created >= AUDIT_EXPORT_STALL_MS) {
    return "stalled";
  }
  return "queued";
}

/** True while a job could still change on its own. */
export function isAuditExportActive(
  job: AuditExportJob,
  now = Date.now(),
): boolean {
  const kind = auditExportKind(job, now);
  return kind === "queued" || kind === "running";
}

/**
 * Poll interval for the history query, or `false` for "do not poll".
 *
 * Returning false rather than a large number matters: TanStack treats false as
 * genuinely off, so a screen left open on a finished history makes no requests
 * at all. A stalled job is deliberately NOT polled — nothing is going to move
 * it, and a 5-second poll against a dead worker is pure battery.
 */
export function auditExportPollMs(
  jobs: readonly AuditExportJob[] | undefined,
  now = Date.now(),
): number | false {
  if (!jobs || jobs.length === 0) return false;
  return jobs.some((job) => isAuditExportActive(job, now)) ? 5_000 : false;
}

/** Percent complete, or null when the server cannot estimate it yet. */
export function auditExportProgressPct(job: AuditExportJob): number | null {
  const estimated = job.estimatedRows;
  const exported = job.exportedRows ?? 0;
  if (typeof estimated !== "number" || !Number.isFinite(estimated) || estimated <= 0) {
    return null;
  }
  const pct = Math.round((exported / estimated) * 100);
  return Math.max(0, Math.min(100, pct));
}

/** The one-line status a history row leads with. */
export function auditExportHeadline(
  job: AuditExportJob,
  now = Date.now(),
): string {
  switch (auditExportKind(job, now)) {
    case "done":
      return `Ready · ${plural(job.exportedRows ?? 0, "row")}`;
    case "failed":
      return "Failed";
    case "running": {
      const pct = auditExportProgressPct(job);
      return pct === null
        ? `Exporting · ${num(job.exportedRows ?? 0)} rows so far`
        : `Exporting · ${pct}%`;
    }
    case "stalled":
      return "Queued — not picked up";
    default:
      return "Queued";
  }
}

/** The supporting line under the headline. Never empty. */
export function auditExportDetail(
  job: AuditExportJob,
  now = Date.now(),
): string {
  const kind = auditExportKind(job, now);
  const started = relativeTime(job.createdAt, { now, fallback: "" });
  if (kind === "failed") {
    const reason = job.errorReason?.trim();
    return reason
      ? `${reason}${started ? ` · requested ${started}` : ""}`
      : `The export worker reported a failure${started ? ` · requested ${started}` : ""}.`;
  }
  if (kind === "done") {
    const size = job.totalBytes ? bytes(job.totalBytes) : null;
    const finished = job.completedAt
      ? relativeTime(job.completedAt, { now, fallback: "" })
      : "";
    return [size, finished ? `finished ${finished}` : null]
      .filter(Boolean)
      .join(" · ") || "Collect it from the web admin.";
  }
  if (kind === "stalled") {
    return `No export worker has picked this job up${
      started ? ` since it was requested ${started}` : ""
    }. It is still queued and will run if a worker starts.`;
  }
  if (kind === "running") {
    const eta = job.etaSeconds;
    return typeof eta === "number" && eta > 0
      ? `About ${plural(Math.max(1, Math.round(eta / 60)), "minute")} remaining.`
      : "The export worker is streaming rows now.";
  }
  const estimated = job.estimatedRows;
  return typeof estimated === "number" && estimated > 0
    ? `About ${plural(estimated, "row")} to export.`
    : "Waiting for the export worker.";
}

/**
 * One sentence for VoiceOver. A history row is a two-line card whose meaning
 * comes from both lines plus the status colour, and colour is not spoken.
 */
export function auditExportSpoken(
  job: AuditExportJob,
  now = Date.now(),
): string {
  return `${auditExportHeadline(job, now)}. ${auditExportDetail(job, now)}`;
}

/** Pill tone per state. Paired with the text above — never colour alone. */
export function auditExportTone(
  kind: AuditExportKind,
): "success" | "danger" | "warning" | "info" | "neutral" {
  switch (kind) {
    case "done":
      return "success";
    case "failed":
      return "danger";
    case "stalled":
      return "warning";
    case "running":
      return "info";
    default:
      return "neutral";
  }
}

/**
 * Normalise GET /api/v1/audit/export-jobs. The envelope is `{ jobs: [...] }`,
 * but a bare array is tolerated for the same reason the audit list tolerates
 * one: an unvalidated wire shape must degrade to "nothing to show", never to a
 * crash on a compliance screen.
 */
export function normalizeAuditExportJobs(res: unknown): AuditExportJob[] {
  const raw = Array.isArray(res)
    ? res
    : (res as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (row): row is AuditExportJob =>
      Boolean(row) &&
      typeof row === "object" &&
      typeof (row as AuditExportJob).id === "string",
  );
}

/**
 * Is a fresh export worth starting, or is one already covering it?
 *
 * Kicking off a second identical job while the first is still queued produces
 * two CSVs of the same rows and two entries in the history, which is how an
 * export list becomes noise. The button reports the in-flight job instead.
 */
export function activeAuditExport(
  jobs: readonly AuditExportJob[] | undefined,
  now = Date.now(),
): AuditExportJob | null {
  for (const job of jobs ?? []) {
    if (isAuditExportActive(job, now)) return job;
  }
  return null;
}
