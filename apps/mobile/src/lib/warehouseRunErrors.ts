/**
 * lib/warehouseRunErrors.ts — what a warehouse run's failure EVIDENCE is, and
 * how honestly it can be stated.
 *
 * This module is the reason the surface is a screen rather than a tile. "Last
 * night's export failed" is not actionable; "23 rows failed with
 * subscriber_not_found" is. But the ledger behind it has two properties that
 * make a naive rendering lie, and both were read out of the Go source:
 *
 *  1. ROW ERRORS ONLY SURVIVE A RUN THAT COMPLETED.
 *     `insertRowError` (imports.go:249) writes into the WORK transaction, and
 *     `failRun` (repo.go:1045-1060) rolls that transaction back before writing
 *     `status='failed'` in a fresh one. So a FAILED run has an empty row-error
 *     ledger by construction — its evidence is the `error` string on the run
 *     itself. Rendering "no errors" there would read as "nothing went wrong",
 *     which is the exact opposite of the truth.
 *
 *  2. THE ROW LEDGER IS CAPPED AT 500 AND IS NOT THE COUNTER.
 *     `Repo.ListRunErrors` ends in `LIMIT 500` (repo.go:753) while
 *     `rows_failed` is a separate integer written by `completeRunTx`. They
 *     routinely disagree — an import that failed 12,000 rows records 500
 *     reasons. Showing the 500 without its denominator turns a sample into a
 *     total.
 *
 * Everything here is a pure function over already-normalised data so it can be
 * unit-tested in the node vitest environment. DELIBERATELY IMPORT-FREE except
 * for the types it classifies.
 */
import type { WarehouseRun } from "@/lib/warehouseRuns";

/** `Repo.ListRunErrors` hard-codes this; the UI must disclose it at the edge. */
export const ROW_ERROR_LIMIT = 500;

export interface WarehouseRowError {
  id: string;
  runId: string;
  sourceObject: string;
  rowNumber: number;
  code: string;
  message: string;
  createdAt: string;
}

export interface WarehouseRowErrorGroup {
  code: string;
  count: number;
  /** The first message seen for the code — they are near-identical per code. */
  sampleMessage: string;
  /** Distinct source objects the code was raised against. */
  sourceObjects: readonly string[];
  /** Lowest row number in the group, or null when the server sent 0s. */
  firstRowNumber: number | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * `id` is a bigserial, so it arrives as a NUMBER, not a string — the only
 * identifier in the warehouse package that is not a uuid.
 */
export function normalizeWarehouseRowErrors(raw: unknown): WarehouseRowError[] {
  const items = Array.isArray(raw)
    ? raw
    : Array.isArray(record(raw).items)
      ? (record(raw).items as unknown[])
      : [];
  return items.map((entry) => {
    const row = record(entry);
    const id = row.id;
    const rowNumber = row.row_number;
    return {
      id:
        typeof id === "number" && Number.isFinite(id) ? String(id) : str(id),
      runId: str(row.run_id),
      sourceObject: str(row.source_object),
      rowNumber:
        typeof rowNumber === "number" && Number.isFinite(rowNumber)
          ? Math.trunc(rowNumber)
          : 0,
      code: str(row.error_code),
      message: str(row.error_message),
      createdAt: str(row.created_at),
    };
  });
}

/**
 * Group by `error_code`, largest group first.
 *
 * A phone cannot usefully scroll 500 near-identical rows; what it can show is
 * "which four things went wrong, and how often". Ties break alphabetically so
 * the order is stable across refetches — a list that reshuffles under a reader
 * every thirty seconds is unreadable.
 */
export function groupWarehouseRowErrors(
  errors: readonly WarehouseRowError[],
): WarehouseRowErrorGroup[] {
  const groups = new Map<string, WarehouseRowErrorGroup>();
  for (const error of errors) {
    const code = error.code || "unspecified";
    const existing = groups.get(code);
    if (!existing) {
      groups.set(code, {
        code,
        count: 1,
        sampleMessage: error.message,
        sourceObjects: error.sourceObject ? [error.sourceObject] : [],
        firstRowNumber: error.rowNumber > 0 ? error.rowNumber : null,
      });
      continue;
    }
    const sources = existing.sourceObjects.includes(error.sourceObject)
      ? existing.sourceObjects
      : error.sourceObject
        ? [...existing.sourceObjects, error.sourceObject]
        : existing.sourceObjects;
    groups.set(code, {
      code,
      count: existing.count + 1,
      sampleMessage: existing.sampleMessage || error.message,
      sourceObjects: sources,
      firstRowNumber:
        error.rowNumber > 0 &&
        (existing.firstRowNumber === null ||
          error.rowNumber < existing.firstRowNumber)
          ? error.rowNumber
          : existing.firstRowNumber,
    });
  }
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.code.localeCompare(b.code),
  );
}

export type RunEvidenceKind =
  | "run_error"
  | "run_error_missing"
  | "row_reasons"
  | "rows_failed_unexplained"
  | "clean"
  | "in_flight"
  | "cancelled"
  | "unknown";

export interface RunEvidence {
  kind: RunEvidenceKind;
  /** One sentence a person can act on. Always non-empty. */
  headline: string;
  /**
   * The qualifier that keeps the headline honest — the denominator, the cap,
   * or why the ledger is empty. "" when the headline needs no qualifier.
   */
  detail: string;
  /** Whether a row-error list is expected to carry anything for this run. */
  expectsRowErrors: boolean;
}

/**
 * The whole judgement of this screen, in one place.
 *
 * `errorCount` is what the errors endpoint actually returned; it is passed in
 * rather than derived so an unloaded query (null) is distinguishable from a
 * loaded-and-empty one — the difference between "we do not know yet" and "the
 * ledger is empty", which are two different sentences.
 */
export function runEvidence(
  run: WarehouseRun,
  errorCount: number | null,
): RunEvidence {
  if (run.outcome === "queued" || run.outcome === "running") {
    return {
      kind: "in_flight",
      headline:
        run.outcome === "queued"
          ? "Queued — it has not started yet."
          : "Running now.",
      detail:
        "Row counts are only written when a run completes, so there is nothing to total yet.",
      expectsRowErrors: false,
    };
  }
  if (run.outcome === "cancelled") {
    return {
      kind: "cancelled",
      headline: "Cancelled before it finished.",
      detail: "No rows were counted and no reasons were recorded.",
      expectsRowErrors: false,
    };
  }
  if (run.outcome === "failed") {
    if (run.error) {
      return {
        kind: "run_error",
        headline: run.error,
        detail:
          "A failed run's per-row ledger is rolled back with the transaction that failed, so the message above is the whole record.",
        expectsRowErrors: false,
      };
    }
    return {
      kind: "run_error_missing",
      headline: "The server recorded a failure with no message.",
      detail:
        "Nothing else was written for this run. The connection's health check and the web admin's run log are the next places to look.",
      expectsRowErrors: false,
    };
  }
  if (run.outcome !== "completed") {
    return {
      kind: "unknown",
      headline: `The server reported an unrecognised status: ${run.status || "none"}.`,
      detail:
        "This build does not know how to read that state, so nothing is inferred from it.",
      expectsRowErrors: false,
    };
  }
  if (run.rowsFailed <= 0) {
    return {
      kind: "clean",
      headline: run.dryRun
        ? "Dry run completed — nothing was written or delivered."
        : "Completed with no failed rows.",
      detail: "",
      expectsRowErrors: false,
    };
  }
  if (errorCount !== null && errorCount === 0) {
    return {
      kind: "rows_failed_unexplained",
      headline: `${run.rowsFailed} rows failed, and no per-row reason was recorded.`,
      detail:
        "Only the import path writes row-level reasons; an export counts failures without them.",
      expectsRowErrors: false,
    };
  }
  return {
    kind: "row_reasons",
    headline: `${run.rowsFailed} rows failed.`,
    detail: rowReasonCoverage(run.rowsFailed, errorCount),
    expectsRowErrors: true,
  };
}

/**
 * What the row-error list says when it has NOTHING to list.
 *
 * "No errors" is the one thing it must never say: for a failed run that reads
 * as "nothing went wrong", which is the exact opposite of the truth. Each
 * branch names the actual reason the ledger is empty, and none of them repeats
 * the sentence the run's detail card is already showing — the same words twice
 * on one screen is a reader wondering which one they missed.
 */
export function emptyRowErrorsMessage(evidence: RunEvidence): string {
  switch (evidence.kind) {
    case "run_error":
    case "run_error_missing":
      return "This run failed outright, so no per-row reasons survived. What the server recorded about the failure is above.";
    case "rows_failed_unexplained":
      return "Only the import path records a reason per row; an export counts its failures without one.";
    case "clean":
      return "Nothing failed in this run, so there is nothing to explain.";
    case "in_flight":
      return "Reasons are written as rows are processed. This run has not finished.";
    case "cancelled":
      return "The run was cancelled, so no rows were processed and no reasons were written.";
    default:
      return "The server recorded no per-row reasons for this run.";
  }
}

/**
 * The denominator sentence.
 *
 * Three genuinely different situations, and the wrong one is a lie:
 *   - the ledger is at the server's 500-row cap → what is shown is a sample;
 *   - the ledger is short of `rows_failed` → some failures have no reason;
 *   - they agree → every failure has a reason.
 */
export function rowReasonCoverage(
  rowsFailed: number,
  errorCount: number | null,
): string {
  if (errorCount === null) return "";
  if (errorCount >= ROW_ERROR_LIMIT) {
    return `Showing the first ${ROW_ERROR_LIMIT} recorded reasons of ${rowsFailed} failed rows — the server caps the ledger there.`;
  }
  if (errorCount < rowsFailed) {
    return `${errorCount} of those ${rowsFailed} rows recorded a reason.`;
  }
  return `Every one of those ${rowsFailed} rows recorded a reason.`;
}
