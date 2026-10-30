/**
 * lib/subscriberImportJobs.ts — the wire shapes and the presentation decisions
 * for subscriber IMPORT jobs, with no React Native import anywhere, so every
 * decision below is unit-testable in the node vitest environment (the pattern
 * lib/reviewQueue.ts established).
 *
 * Every field name here was read off the Go handlers in
 * `apps/api/internal/subscriber_import/subscriber_import.go`, not off
 * openapi.json:
 *
 *   - `Deps.List`  (subscriber_import.go:1305) writes the row map literally:
 *     id / filename / status / rows_total / rows_new / rows_existing /
 *     rows_file_dupes / rows_imported / rows_skipped / rows_failed /
 *     on_existing / error_code / error / created_at / processed_rows /
 *     cancel_requested / last_chunk_at, wrapped in
 *     `{imports, has_more, next_cursor}`.
 *   - `Deps.Get`   (subscriber_import.go:1436) returns the same fields plus the
 *     preflight / consent / schedule state the confirm gate reads.
 *
 * THREE SERVER FACTS SHAPE THIS MODULE AND ARE EASY TO GET WRONG
 *
 *  1. THE STATUS SET IS SIX WIDE, NOT FOUR. `worker.go` moves a row through
 *     preview → queued → running → ready|failed|cancelled, and `Deps.Cancel`
 *     can jump queued straight to cancelled. `preview` is NOT "in progress":
 *     it is a staged upload waiting for a human, and it is the only status
 *     where Confirm is legal.
 *  2. A FAILED JOB'S ERROR IS SANITISED, AND ONLY WHEN IT FAILED.
 *     `safeImportJobErrorCode` (worker.go:960) returns "" for every status
 *     except `failed`, so a non-empty `error_code` on a running row is not a
 *     thing the server emits — treating a blank one as "unknown error" would
 *     invent a failure.
 *  3. ABSENCE IS NOT ZERO. The SQL COALESCEs the counters, so a real response
 *     always carries numbers — which is exactly why a MISSING one means the
 *     payload drifted, not that the count is 0. Every counter parses to
 *     `number | null` and the screen renders null as an em-dash.
 */

/** The statuses `subscriber_imports.status` actually takes (worker.go). */
export const SUBSCRIBER_IMPORT_STATUSES = [
  "preview",
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
] as const;

export type SubscriberImportStatus =
  (typeof SUBSCRIBER_IMPORT_STATUSES)[number];

/** The segmented buckets worth offering on a phone. */
export const IMPORT_FILTERS = ["active", "staged", "done"] as const;
export type ImportFilter = (typeof IMPORT_FILTERS)[number];

export interface SubscriberImportJob {
  id: string;
  filename: string;
  /** Verbatim server status — may be an unrecognised value on an old server. */
  status: string;
  rowsTotal: number | null;
  rowsNew: number | null;
  rowsExisting: number | null;
  rowsFileDupes: number | null;
  rowsImported: number | null;
  rowsSkipped: number | null;
  rowsFailed: number | null;
  processedRows: number | null;
  onExisting: string;
  errorCode: string;
  errorMessage: string;
  createdAt: string | null;
  cancelRequested: boolean;
  lastChunkAt: string | null;
}

/**
 * The extra state only `GET /{id}` carries. It is what makes an honest Confirm
 * possible: the handler refuses a confirm whose preflight is missing, expired
 * or stale, so the phone can say WHICH of those it is instead of firing a POST
 * that is already known to 409.
 */
export interface SubscriberImportJobDetail extends SubscriberImportJob {
  preflightRequired: boolean;
  classificationAuthoritative: boolean;
  preflightExpiresAt: string | null;
  sourceFingerprint: string;
  consentContractState: string;
  scheduleType: string;
  nextScheduledAt: string | null;
  dryRun: boolean;
}

export interface SubscriberImportPage {
  jobs: SubscriberImportJob[];
  hasMore: boolean;
  nextCursor: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * `number | null`, never a substituted 0. A JSON number arrives as a number;
 * a numeric string is tolerated because the counters are `int64` server-side
 * and a future encoder change to string-encoded 64-bit integers must not
 * silently zero every count on the screen.
 */
export function count(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** ISO timestamp or null. `rfc3339OrEmpty` emits "" for a NULL column. */
export function timestamp(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  if (raw.startsWith("0001-01-01")) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

export function parseImportJob(value: unknown): SubscriberImportJob | null {
  const row = record(value);
  const id = str(row["id"]);
  if (!id) return null;
  const status = str(row["status"]) || "preview";
  return {
    id,
    // A blank original_filename is possible on a legacy row; naming it
    // "Untitled" beats an empty row title the user cannot refer to.
    filename: str(row["filename"]) || "Untitled upload",
    status,
    rowsTotal: count(row["rows_total"]),
    rowsNew: count(row["rows_new"]),
    rowsExisting: count(row["rows_existing"]),
    rowsFileDupes: count(row["rows_file_dupes"]),
    rowsImported: count(row["rows_imported"]),
    rowsSkipped: count(row["rows_skipped"]),
    rowsFailed: count(row["rows_failed"]),
    processedRows: count(row["processed_rows"]),
    onExisting: str(row["on_existing"]),
    // Both are "" for every non-failed status by construction, so carrying
    // them through unconditionally cannot manufacture a failure.
    errorCode: str(row["error_code"]),
    errorMessage: str(row["error"]),
    createdAt: timestamp(row["created_at"]),
    cancelRequested: row["cancel_requested"] === true,
    lastChunkAt: timestamp(row["last_chunk_at"]),
  };
}

export function parseImportJobDetail(
  value: unknown,
): SubscriberImportJobDetail | null {
  const base = parseImportJob(value);
  if (!base) return null;
  const row = record(value);
  return {
    ...base,
    preflightRequired: row["preflight_required"] === true,
    classificationAuthoritative: row["classification_authoritative"] === true,
    preflightExpiresAt: timestamp(row["preflight_expires_at"]),
    sourceFingerprint: str(row["source_fingerprint"]),
    consentContractState: str(row["consent_contract_state"]) || "none",
    scheduleType: str(row["schedule_type"]) || "immediate",
    nextScheduledAt: timestamp(row["next_scheduled_at"]),
    dryRun: row["dry_run"] === true,
  };
}

/**
 * `{imports, has_more, next_cursor}`. A bare array is accepted too: envelope
 * drift silently emptying a mobile list is the single most common failure in
 * this codebase's mobile audit, and one line of tolerance removes it.
 */
export function parseImportJobPage(payload: unknown): SubscriberImportPage {
  const envelope = record(payload);
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(envelope["imports"])
      ? (envelope["imports"] as unknown[])
      : [];
  const jobs = source
    .map(parseImportJob)
    .filter((job): job is SubscriberImportJob => job !== null);
  return {
    jobs,
    hasMore: envelope["has_more"] === true,
    nextCursor: str(envelope["next_cursor"]),
  };
}

/* ----------------------------- presentation ----------------------------- */

export interface ImportStatusPresentation {
  label: string;
  tone: "neutral" | "accent" | "success" | "warning" | "danger" | "info";
  /** One sentence explaining what the status means for the operator. */
  description: string;
}

export function importStatusPresentation(
  status: string,
  cancelRequested = false,
): ImportStatusPresentation {
  switch (status.trim().toLowerCase()) {
    case "preview":
      return {
        label: "Staged",
        tone: "info",
        description:
          "Uploaded and mapped, waiting for someone to confirm it. Nothing has been written yet.",
      };
    case "queued":
      return cancelRequested
        ? {
            label: "Stopping",
            tone: "warning",
            description: "Cancellation requested — it will not start.",
          }
        : {
            label: "Queued",
            tone: "accent",
            description: "Confirmed and waiting for the import worker.",
          };
    case "running":
      return cancelRequested
        ? {
            label: "Stopping",
            tone: "warning",
            description:
              "Cancellation requested. The worker stops between chunks, so rows already written stay written.",
          }
        : {
            label: "Running",
            tone: "accent",
            description: "The worker is writing subscribers in chunks.",
          };
    case "ready":
      return {
        label: "Finished",
        tone: "success",
        description: "The import completed.",
      };
    case "failed":
      return {
        label: "Failed",
        tone: "danger",
        description: "The import stopped on an error.",
      };
    case "cancelled":
      return {
        label: "Cancelled",
        tone: "neutral",
        description: "Stopped before it finished.",
      };
    default:
      // An unrecognised status must never read as finished.
      return {
        label: status.trim() || "Unknown",
        tone: "neutral",
        description: "This server reported a status this app doesn't know.",
      };
  }
}

/** queued or running — the two statuses the worker is (or will be) on. */
export function isActiveImport(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "queued" || normalized === "running";
}

/** The worker is done with the row: `terminalStatus` in subscriber_import.go. */
export function isTerminalImport(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return (
    normalized === "ready" || normalized === "failed" || normalized === "cancelled"
  );
}

export function importFilterFor(status: string): ImportFilter {
  if (isActiveImport(status)) return "active";
  return status.trim().toLowerCase() === "preview" ? "staged" : "done";
}

export function filterImportJobs(
  jobs: readonly SubscriberImportJob[],
  filter: ImportFilter,
): SubscriberImportJob[] {
  return jobs.filter((job) => importFilterFor(job.status) === filter);
}

/**
 * How many jobs sit in each bucket. Every job lands in exactly one, so the
 * three counts sum to `jobs.length` — including a job whose status this build
 * does not recognise, which `importFilterFor` files under "done" rather than
 * dropping (a job that vanishes from every tab is worse than one filed oddly).
 */
export function importFilterCounts(
  jobs: readonly SubscriberImportJob[],
): Record<ImportFilter, number> {
  const counts: Record<ImportFilter, number> = {
    active: 0,
    staged: 0,
    done: 0,
  };
  for (const job of jobs) counts[importFilterFor(job.status)] += 1;
  return counts;
}

/**
 * `processed_rows / rows_total`, or null when there is no progress to draw.
 *
 * Null in three cases, and the third is the subtle one:
 *   - a counter is missing (the payload drifted),
 *   - `rows_total` is 0 or unknown (nothing to divide by),
 *   - the row is still in `preview`. A staged import has NOT been handed to the
 *     worker, so its `processed_rows` of 0 is not a measurement of anything. A
 *     determinate 0%-wide bar beside "Staged" claims the worker has started and
 *     achieved nothing, which is the opposite of the truth.
 *
 * `queued` is deliberately NOT excluded: Confirm resets the counters to 0 and
 * the worker is genuinely about to move them, so an empty bar there is an
 * honest "0 of 50,000 so far".
 */
export function importProgressFraction(
  job: Pick<SubscriberImportJob, "processedRows" | "rowsTotal" | "status">,
): number | null {
  const { processedRows, rowsTotal } = job;
  if (job.status.trim().toLowerCase() === "preview") return null;
  if (processedRows === null || rowsTotal === null || rowsTotal <= 0) {
    return null;
  }
  return Math.min(1, Math.max(0, processedRows / rowsTotal));
}

/**
 * The spoken progress fact. Returns null when there is no measurement,
 * so the caller renders an em-dash rather than "0 of 0 rows".
 */
export function importProgressCounts(
  job: Pick<SubscriberImportJob, "processedRows" | "rowsTotal">,
): { processed: number; total: number } | null {
  if (job.processedRows === null || job.rowsTotal === null) return null;
  return { processed: job.processedRows, total: job.rowsTotal };
}

/**
 * How often to re-read one job, in ms, or `false` for "don't". Expo Router
 * keeps visited tabs mounted, so an unconditional interval polls forever on a
 * screen nobody is looking at — the battery bug useDashboard's `focused` flag
 * exists to prevent. Here the interval ALSO stops the moment the job reaches a
 * terminal status, because a finished job cannot change again.
 */
export const IMPORT_RUNNING_POLL_MS = 3_000;
export const IMPORT_QUEUED_POLL_MS = 6_000;

export function importPollIntervalMs(
  status: string | null | undefined,
  options: { focused: boolean; online: boolean },
): number | false {
  if (!options.focused || !options.online) return false;
  const normalized = (status ?? "").trim().toLowerCase();
  if (normalized === "running") return IMPORT_RUNNING_POLL_MS;
  if (normalized === "queued") return IMPORT_QUEUED_POLL_MS;
  return false;
}

/**
 * The outcome line for a job that has stopped. `null` while it is still in
 * flight — quoting "imported 0" mid-run reads as a failure that has not
 * happened.
 */
export function importOutcomeCounts(
  job: SubscriberImportJob,
): { imported: number | null; skipped: number | null; failed: number | null } | null {
  if (!isTerminalImport(job.status)) return null;
  return {
    imported: job.rowsImported,
    skipped: job.rowsSkipped,
    failed: job.rowsFailed,
  };
}

/**
 * What `on_existing` does, in words. The enum is validated at confirm time
 * (`skip|update|error`, subscriber_import.go:906) and decides whether an
 * import overwrites people who already exist — which is the single most
 * consequential setting on the job.
 */
export function onExistingDescription(onExisting: string): string | null {
  switch (onExisting.trim().toLowerCase()) {
    case "skip":
      return "Existing subscribers are left untouched.";
    case "update":
      return "Existing subscribers are updated with the file's values.";
    case "error":
      return "Any row matching an existing subscriber fails the import.";
    default:
      return null;
  }
}
