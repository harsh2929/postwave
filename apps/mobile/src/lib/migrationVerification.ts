/**
 * lib/migrationVerification.ts — reading a migration's verification report on a
 * phone.
 *
 * WHY THIS EXISTS. `GET /api/v1/migrations/{job_id}/verification` returns
 * `canonical.VerificationReport` (packages/migrate/canonical/types.go:429) —
 * twenty-two fields, seven of which are arrays of warning objects. The mobile
 * Migrations screen showed a status pill, a progress bar and a truncated error
 * string, so a six-hour import that "completed" with a 12% data-loss estimate
 * and nine unsupported automations looked identical to a clean one.
 *
 * THE 404 IS A STATE, NOT A FAILURE. The handler answers 404 with "verification
 * report not yet available" whenever `job.VerificationReport == nil`
 * (services/migration/internal/handlers/migration.go:2910). That is the normal
 * answer for a job that is still running, and rendering it as an error would
 * tell an operator something is broken while their import is working fine.
 * `verificationAbsenceCopy` is the sentence for it.
 *
 * ABSENCE IS NOT ZERO. Every count is `number | null`: a report that omits
 * `templates_imported` is not a report saying zero templates were imported, and
 * the difference matters when the question is "did my templates come across?".
 * The renderer prints an em-dash for null.
 *
 * Import-free by construction, so all of it is testable in the node vitest run
 * without React Native.
 */

/** A count that may legitimately be absent. Never coerced to 0. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function ratio(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** One `resource_completeness` entry, reduced to what a phone can show. */
export interface MigrationResourceRow {
  resource: string;
  imported: number | null;
  expected: number | null;
  /** 0..1, or null when the server did not send a usable pair. */
  completeness: number | null;
  note: string | null;
}

export interface MigrationVerification {
  subscribersImported: number | null;
  suppressionListSize: number | null;
  consentKnown: number | null;
  consentUnknown: number | null;
  duplicatesMerged: number | null;
  segmentsTranslated: number | null;
  segmentWarnings: number | null;
  automationsTranslated: number | null;
  automationsUnsupported: number | null;
  templatesImported: number | null;
  archiveImported: number | null;
  customFieldsMapped: number | null;
  customFieldsUnmapped: number | null;
  /** Percentage as the server sends it (0..100), or null. */
  dataLossEstimatePct: number | null;
  resources: MigrationResourceRow[];
  /** Free-text discovery warnings, capped by the caller. */
  discoveryWarnings: string[];
}

const RESOURCE_IMPORTED_KEYS = ["imported", "actual", "count", "found"];
const RESOURCE_EXPECTED_KEYS = ["expected", "source_total", "total"];

function pick(row: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = count(row[key]);
    if (value !== null) return value;
  }
  return null;
}

function parseResourceRow(value: unknown): MigrationResourceRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const resource = text(row.resource) ?? text(row.name);
  if (!resource) return null;
  const imported = pick(row, RESOURCE_IMPORTED_KEYS);
  const expected = pick(row, RESOURCE_EXPECTED_KEYS);
  // A completeness the SERVER computed wins; otherwise derive it, but only
  // when both halves are real numbers and the denominator is non-zero.
  const served = ratio(row.completeness ?? row.completeness_pct);
  const derived =
    imported !== null && expected !== null && expected > 0
      ? imported / expected
      : null;
  return {
    resource,
    imported,
    expected,
    completeness:
      served !== null ? (served > 1 ? served / 100 : served) : derived,
    note: text(row.note) ?? text(row.warning) ?? null,
  };
}

export function parseMigrationVerification(
  value: unknown,
): MigrationVerification | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    subscribersImported: count(raw.subscribers_imported),
    suppressionListSize: count(raw.suppression_list_size),
    consentKnown: count(raw.consent_known),
    consentUnknown: count(raw.consent_unknown),
    duplicatesMerged: count(raw.duplicate_subscribers_merged),
    segmentsTranslated: count(raw.segments_translated),
    segmentWarnings: arrayLength(raw.segments_with_warnings),
    automationsTranslated: count(raw.automations_translated),
    automationsUnsupported: arrayLength(raw.automations_unsupported),
    templatesImported: count(raw.templates_imported),
    archiveImported: count(raw.archive_imported),
    customFieldsMapped: arrayLength(raw.custom_fields_mapped),
    customFieldsUnmapped: arrayLength(raw.custom_fields_unmapped),
    dataLossEstimatePct: ratio(raw.data_loss_estimate_pct),
    resources: Array.isArray(raw.resource_completeness)
      ? raw.resource_completeness
          .map(parseResourceRow)
          .filter((row): row is MigrationResourceRow => row !== null)
      : [],
    discoveryWarnings: Array.isArray(raw.discovery_warnings)
      ? raw.discovery_warnings
          .map(text)
          .filter((line): line is string => line !== null)
      : [],
  };
}

export type VerificationRisk = "clean" | "review" | "loss";

/**
 * The headline verdict.
 *
 * "Clean" is deliberately hard to earn: any estimated data loss at all, any
 * unsupported automation, any segment warning and any unmapped custom field
 * are all things a human has to look at before they tell a client the
 * migration is done. Understating that on a phone is worse than saying
 * nothing, because the phone is where the "did it work?" question gets its
 * final answer.
 */
export function verificationRisk(
  report: MigrationVerification,
): VerificationRisk {
  if ((report.dataLossEstimatePct ?? 0) > 0) return "loss";
  if (
    (report.automationsUnsupported ?? 0) > 0 ||
    (report.segmentWarnings ?? 0) > 0 ||
    (report.customFieldsUnmapped ?? 0) > 0 ||
    report.discoveryWarnings.length > 0
  ) {
    return "review";
  }
  return "clean";
}

export function verificationRiskCopy(risk: VerificationRisk): {
  headline: string;
  detail: string;
} {
  switch (risk) {
    case "loss":
      return {
        headline: "Estimated data loss",
        detail:
          "The report estimates that some source data did not come across. Review it on desktop before telling anyone the migration is complete.",
      };
    case "review":
      return {
        headline: "Needs review",
        detail:
          "Everything imported, but the report flags translations that need a human: unsupported automations, segment warnings, or fields with nowhere to go.",
      };
    default:
      return {
        headline: "No warnings",
        detail:
          "The report records no estimated loss, no unsupported automations and no unmapped fields.",
      };
  }
}

/**
 * What to say when there is no report.
 *
 * A 404 here is the server's normal answer for a job that has not produced one
 * yet, so the copy depends on the job's status rather than on the HTTP code:
 * "still running" and "this job failed before it got far enough" are different
 * facts, and only the second is worth worrying about.
 */
export function verificationAbsenceCopy(status: string | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (
    s === "completed" ||
    s === "rolled_back" ||
    s === "committed"
  ) {
    return "This job finished without writing a verification report. That is unusual — check it on desktop.";
  }
  if (s === "failed") {
    return "This job failed before a verification report was written, so there is nothing to verify. The error above is the whole story.";
  }
  return "No verification report yet. It is written when the import finishes; pull to refresh once the job completes.";
}

/** Rollback progress, as `rollbackProgressFromJob` shapes it. */
export interface MigrationRollbackStatus {
  state: string | null;
  deleted: number | null;
  total: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export function parseMigrationRollback(
  value: unknown,
): MigrationRollbackStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const state = text(raw.state) ?? text(raw.status);
  const deleted = count(raw.deleted) ?? count(raw.removed) ?? count(raw.done);
  const total = count(raw.total) ?? count(raw.expected);
  if (
    state === null &&
    deleted === null &&
    total === null &&
    !text(raw.error)
  ) {
    return null;
  }
  return {
    state,
    deleted,
    total,
    startedAt: text(raw.started_at),
    finishedAt: text(raw.finished_at) ?? text(raw.completed_at),
    error: text(raw.error),
  };
}

/**
 * Is a rollback worth asking about for this job?
 *
 * `GET /{job_id}/rollback-status` recreates a rollback worker for a job in
 * `rolling_back` (migration.go:3035-3042), so calling it speculatively on every
 * job in the list would be a side effect, not a read. It is asked only for the
 * two states where a rollback exists to report on.
 */
export function shouldReadRollbackStatus(status: string | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "rolling_back" || s === "rolled_back";
}
