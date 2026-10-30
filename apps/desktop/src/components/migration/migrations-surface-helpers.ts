import type {
  ApiErr,
  MigrationJob,
  MigrationProgress,
  MigrationProgressEvent,
  MigrationResource,
  MigrationSource,
  MigrationStatus,
  MigrationVerificationReport,
} from "../../lib/api-client";
import { findSource } from "../../lib/migration-sources";
import {
  remoteFailureFromError,
  type RemoteApiError,
  type RemoteFailure,
} from "../../lib/remote-resource";

const TERMINAL_STATUSES: ReadonlySet<MigrationStatus> = new Set([
  "completed",
  "failed",
  "rolled_back",
]);

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "authenticating",
  "discovering",
  "dry_run",
  "awaiting_confirmation",
  "importing",
  "rolling_back",
  "completed",
  "failed",
  "rolled_back",
]);

const KNOWN_RESOURCES: ReadonlySet<MigrationResource> = new Set([
  "subscribers",
  "segments",
  "automations",
  "archive",
  "paid_subs",
  "templates",
  "source_archive",
  "all",
]);

export type MigrationStatusFilter =
  | "all"
  | "in_flight"
  | "completed"
  | "failed"
  | "rolled_back";

export type MigrationCounts = Record<MigrationStatusFilter, number>;

export type MigrationStreamStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "idle";

export const MIGRATION_FILTERS: ReadonlyArray<{
  value: MigrationStatusFilter;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "in_flight", label: "In flight" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "rolled_back", label: "Rolled back" },
];

export function isMigrationInFlight(
  status: MigrationStatus | string | undefined,
): boolean {
  if (!status) return false;
  return !TERMINAL_STATUSES.has(status as MigrationStatus);
}

export function isMigrationCancellable(
  status: MigrationStatus | string | undefined,
): boolean {
  return [
    "pending",
    "authenticating",
    "discovering",
    "dry_run",
    "awaiting_confirmation",
    "importing",
  ].includes(status ?? "");
}

export function migrationStatusLabel(
  status: MigrationStatus | string | undefined,
): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "authenticating":
      return "Authenticating";
    case "discovering":
      return "Discovering";
    case "dry_run":
      return "Dry run";
    case "awaiting_confirmation":
      return "Awaiting confirmation";
    case "importing":
      return "Importing";
    case "rolling_back":
      return "Rolling back";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "rolled_back":
      return "Rolled back";
    default:
      return "Unknown status";
  }
}

export function migrationStatusTone(
  status: MigrationStatus | string | undefined,
): "success" | "danger" | "warning" | "accent" | "neutral" {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "awaiting_confirmation") return "warning";
  if (
    status === "importing" ||
    status === "discovering" ||
    status === "dry_run" ||
    status === "rolling_back"
  ) {
    return "accent";
  }
  return "neutral";
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function formatMigrationCount(value: unknown): string {
  const number = finiteNonNegative(value);
  return number === undefined ? "Not reported" : number.toLocaleString();
}

export function parseMigrationTime(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatMigrationAbsoluteTime(value: unknown): string {
  const parsed = parseMigrationTime(value);
  if (parsed === null) return "Not recorded";
  return new Date(parsed).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "long",
  });
}

export function formatMigrationRelativeTime(
  value: unknown,
  now = Date.now(),
): string {
  const parsed = parseMigrationTime(value);
  if (parsed === null) return "time not recorded";
  const delta = parsed - now;
  const absolute = Math.abs(delta);
  if (absolute < 60_000) return delta >= 0 ? "in under a minute" : "just now";

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  const [unit, divisor] =
    units.find(([, candidate]) => absolute >= candidate) ?? units[2]!;
  const amount = Math.round(delta / divisor);
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    amount,
    unit,
  );
}

export function migrationTimeDateTime(value: unknown): string | undefined {
  const parsed = parseMigrationTime(value);
  return parsed === null ? undefined : new Date(parsed).toISOString();
}

export function normalizeMigrationProgress(
  value: unknown,
): MigrationProgress | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys: Array<keyof MigrationProgress> = [
    "subscribers_total",
    "subscribers_done",
    "segments_total",
    "segments_done",
    "automations_total",
    "automations_done",
    "paid_subs_total",
    "paid_subs_done",
    "archive_total",
    "archive_done",
    "templates_total",
    "templates_done",
    "source_archive_total",
    "source_archive_done",
  ];
  const progress: MigrationProgress = {};
  for (const key of keys) {
    const safe = finiteNonNegative(record[key]);
    if (safe !== undefined) progress[key] = safe;
  }
  return Object.keys(progress).length > 0 ? progress : undefined;
}

export function normalizeMigrationJob(value: unknown): MigrationJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const source =
    typeof candidate.source === "string" ? candidate.source.trim() : "";
  const status =
    typeof candidate.status === "string" ? candidate.status.trim() : "";
  if (
    !id ||
    id.length > 512 ||
    !source ||
    source.length > 128 ||
    !findSource(source) ||
    !KNOWN_STATUSES.has(status)
  ) {
    return null;
  }
  const selectedAudienceIds = normalizeSelectedAudienceIds(
    candidate.selected_audience_ids,
  );
  if (selectedAudienceIds === null) return null;
  const progress = normalizeMigrationProgress(candidate.progress);
  if (
    candidate.progress !== undefined &&
    (!candidate.progress ||
      typeof candidate.progress !== "object" ||
      Array.isArray(candidate.progress) ||
      hasInvalidMigrationProgressField(candidate.progress))
  ) {
    return null;
  }
  const startedAt = normalizeMigrationTimestamp(candidate.started_at, false);
  const completedAt = normalizeMigrationTimestamp(candidate.completed_at, true);
  const rollbackUntil = normalizeMigrationTimestamp(
    candidate.rollback_until,
    true,
  );
  const sourceSessionExpiresAt = normalizeMigrationTimestamp(
    candidate.source_session_expires_at,
    true,
  );
  const cursor = normalizeMigrationCursor(candidate.cursor);
  const verificationReport = normalizeMigrationVerificationReport(
    candidate.verification_report,
  );
  if (
    startedAt === INVALID_MIGRATION_VALUE ||
    completedAt === INVALID_MIGRATION_VALUE ||
    rollbackUntil === INVALID_MIGRATION_VALUE ||
    sourceSessionExpiresAt === INVALID_MIGRATION_VALUE ||
    cursor === INVALID_MIGRATION_VALUE ||
    verificationReport === INVALID_MIGRATION_VALUE
  ) {
    return null;
  }
  const rawError =
    typeof candidate.error === "string" && candidate.error.trim()
      ? candidate.error
      : null;
  const cancelled =
    status === "failed" && rawError !== null && /cancel/i.test(rawError);
  return {
    id,
    source: source as MigrationSource,
    status: status as MigrationStatus,
    ...(progress ? { progress } : {}),
    ...(cursor ? { cursor } : {}),
    ...(typeof startedAt === "string" ? { started_at: startedAt } : {}),
    ...(completedAt !== undefined ? { completed_at: completedAt } : {}),
    ...(rollbackUntil !== undefined ? { rollback_until: rollbackUntil } : {}),
    ...(sourceSessionExpiresAt !== undefined
      ? { source_session_expires_at: sourceSessionExpiresAt }
      : {}),
    ...(selectedAudienceIds !== undefined
      ? { selected_audience_ids: selectedAudienceIds }
      : {}),
    ...(verificationReport !== undefined
      ? { verification_report: verificationReport }
      : {}),
    error: rawError
      ? cancelled
        ? "migration cancelled by operator"
        : "Migration failure detail withheld"
      : null,
  };
}

const INVALID_MIGRATION_VALUE = Symbol("invalid-migration-value");

function hasInvalidMigrationProgressField(value: object): boolean {
  const record = value as Record<string, unknown>;
  const keys: Array<keyof MigrationProgress> = [
    "subscribers_total",
    "subscribers_done",
    "segments_total",
    "segments_done",
    "automations_total",
    "automations_done",
    "paid_subs_total",
    "paid_subs_done",
    "archive_total",
    "archive_done",
    "templates_total",
    "templates_done",
    "source_archive_total",
    "source_archive_done",
  ];
  return keys.some(
    (key) =>
      record[key] !== undefined && safeMigrationCount(record[key]) === null,
  );
}

function safeMigrationCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function normalizeMigrationTimestamp(
  value: unknown,
  nullable: boolean,
): string | null | undefined | typeof INVALID_MIGRATION_VALUE {
  if (value === undefined) return undefined;
  if (value === null) return nullable ? null : INVALID_MIGRATION_VALUE;
  if (typeof value !== "string") return INVALID_MIGRATION_VALUE;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      normalized,
    ) ||
    parseMigrationTime(normalized) === null
  ) {
    return INVALID_MIGRATION_VALUE;
  }
  return new Date(Date.parse(normalized)).toISOString();
}

function normalizeMigrationCursor(
  value: unknown,
): Record<string, string | null> | undefined | typeof INVALID_MIGRATION_VALUE {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return INVALID_MIGRATION_VALUE;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 256) return INVALID_MIGRATION_VALUE;
  const redacted: Record<string, string | null> = {};
  for (const [key, raw] of entries) {
    if (
      !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(key) ||
      (raw !== null && (typeof raw !== "string" || raw.length > 4_096))
    ) {
      return INVALID_MIGRATION_VALUE;
    }
    // Renderer surfaces use only cursor-key presence as checkpoint evidence.
    // Values may contain provider state and are intentionally never retained.
    redacted[key] = null;
  }
  return redacted;
}

const MIGRATION_REPORT_COUNT_FIELDS = [
  "subscribers_imported",
  "suppression_list_size",
  "segments_translated",
  "automations_translated",
  "paid_subs_imported",
  "premium_memberships_observed",
  "archive_imported",
  "source_archive_imported",
  "consent_known",
  "consent_unknown",
  "duplicate_subscribers_merged",
  "templates_imported",
] as const satisfies ReadonlyArray<keyof MigrationVerificationReport>;

const MIGRATION_COMPLETENESS_STATUSES = new Set([
  "imported_runtime",
  "partial_runtime",
  "preserved_for_rebuild",
  "manual_rebuild_required",
  "not_supported",
  "not_detected",
]);

export function normalizeMigrationVerificationReport(
  value: unknown,
):
  | MigrationVerificationReport
  | null
  | undefined
  | typeof INVALID_MIGRATION_VALUE {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return INVALID_MIGRATION_VALUE;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length > 64) return INVALID_MIGRATION_VALUE;
  const report: MigrationVerificationReport = {};
  for (const field of MIGRATION_REPORT_COUNT_FIELDS) {
    const raw = record[field];
    if (raw === undefined) continue;
    const count = safeMigrationCount(raw);
    if (count === null) return INVALID_MIGRATION_VALUE;
    report[field] = count;
  }
  if (record.data_loss_estimate_pct !== undefined) {
    const loss = record.data_loss_estimate_pct;
    if (
      typeof loss !== "number" ||
      !Number.isFinite(loss) ||
      loss < 0 ||
      loss > 100
    ) {
      return INVALID_MIGRATION_VALUE;
    }
    report.data_loss_estimate_pct = loss;
  }

  const discoveryWarnings = normalizeEvidenceStringArray(
    record.discovery_warnings,
  );
  const unmappedFields = normalizeEvidenceStringArray(
    record.custom_fields_unmapped,
  );
  if (
    discoveryWarnings === INVALID_MIGRATION_VALUE ||
    unmappedFields === INVALID_MIGRATION_VALUE
  ) {
    return INVALID_MIGRATION_VALUE;
  }
  if (discoveryWarnings !== undefined)
    report.discovery_warnings = discoveryWarnings;
  if (unmappedFields !== undefined)
    report.custom_fields_unmapped = unmappedFields;

  const mappings = normalizeMigrationMappings(record.custom_fields_mapped);
  const segmentWarnings = normalizeNamedWarnings(
    record.segments_with_warnings,
    "warning",
  );
  const unsupportedAutomations = normalizeNamedWarnings(
    record.automations_unsupported,
    "reason",
  );
  const completeness = normalizeMigrationCompleteness(
    record.resource_completeness,
  );
  const campaignWarnings = normalizeMigrationResourceWarnings(
    record.campaign_archive_warnings,
  );
  const templateWarnings = normalizeMigrationResourceWarnings(
    record.template_warnings,
  );
  const sourceWarnings = normalizeMigrationResourceWarnings(
    record.source_archive_warnings,
  );
  const mergeConflicts = normalizeMigrationMergeConflicts(
    record.subscriber_merge_conflicts,
  );
  const archiveCounts = normalizeMigrationCountRecord(
    record.source_archive_by_resource,
  );
  if (
    mappings === INVALID_MIGRATION_VALUE ||
    segmentWarnings === INVALID_MIGRATION_VALUE ||
    unsupportedAutomations === INVALID_MIGRATION_VALUE ||
    completeness === INVALID_MIGRATION_VALUE ||
    campaignWarnings === INVALID_MIGRATION_VALUE ||
    templateWarnings === INVALID_MIGRATION_VALUE ||
    sourceWarnings === INVALID_MIGRATION_VALUE ||
    mergeConflicts === INVALID_MIGRATION_VALUE ||
    archiveCounts === INVALID_MIGRATION_VALUE
  ) {
    return INVALID_MIGRATION_VALUE;
  }
  if (mappings !== undefined) report.custom_fields_mapped = mappings;
  if (segmentWarnings !== undefined)
    report.segments_with_warnings = segmentWarnings;
  if (unsupportedAutomations !== undefined)
    report.automations_unsupported = unsupportedAutomations;
  if (completeness !== undefined) report.resource_completeness = completeness;
  if (campaignWarnings !== undefined)
    report.campaign_archive_warnings = campaignWarnings;
  if (templateWarnings !== undefined)
    report.template_warnings = templateWarnings;
  if (sourceWarnings !== undefined)
    report.source_archive_warnings = sourceWarnings;
  if (mergeConflicts !== undefined)
    report.subscriber_merge_conflicts = mergeConflicts;
  if (archiveCounts !== undefined)
    report.source_archive_by_resource = archiveCounts;
  return report;
}

function normalizeEvidenceStringArray(
  value: unknown,
): string[] | undefined | typeof INVALID_MIGRATION_VALUE {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1_000) {
    return INVALID_MIGRATION_VALUE;
  }
  if (value.some((item) => typeof item !== "string" || item.length > 4_096)) {
    return INVALID_MIGRATION_VALUE;
  }
  return value.map(safeMigrationEvidenceText);
}

function normalizeMigrationMappings(
  value: unknown,
):
  | NonNullable<MigrationVerificationReport["custom_fields_mapped"]>
  | undefined
  | typeof INVALID_MIGRATION_VALUE {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1_000) {
    return INVALID_MIGRATION_VALUE;
  }
  const mappings: NonNullable<
    MigrationVerificationReport["custom_fields_mapped"]
  > = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return INVALID_MIGRATION_VALUE;
    }
    const row = raw as Record<string, unknown>;
    if (
      typeof row.source !== "string" ||
      typeof row.canonical !== "string" ||
      typeof row.type !== "string"
    ) {
      return INVALID_MIGRATION_VALUE;
    }
    mappings.push({
      source: safeMigrationEvidenceText(row.source),
      canonical: safeMigrationEvidenceText(row.canonical),
      type: safeMigrationEvidenceText(row.type),
    });
  }
  return mappings;
}

function normalizeNamedWarnings(
  value: unknown,
  detailKey: "warning",
):
  | Array<{ name: string; warning: string }>
  | undefined
  | typeof INVALID_MIGRATION_VALUE;
function normalizeNamedWarnings(
  value: unknown,
  detailKey: "reason",
):
  | Array<{ name: string; reason: string }>
  | undefined
  | typeof INVALID_MIGRATION_VALUE;
function normalizeNamedWarnings(
  value: unknown,
  detailKey: "warning" | "reason",
):
  | Array<{ name: string; warning: string }>
  | Array<{ name: string; reason: string }>
  | undefined
  | typeof INVALID_MIGRATION_VALUE {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1_000) {
    return INVALID_MIGRATION_VALUE;
  }
  const rows: Array<Record<string, string>> = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return INVALID_MIGRATION_VALUE;
    }
    const row = raw as Record<string, unknown>;
    if (typeof row.name !== "string" || typeof row[detailKey] !== "string") {
      return INVALID_MIGRATION_VALUE;
    }
    rows.push({
      name: safeMigrationEvidenceText(row.name),
      [detailKey]: safeMigrationEvidenceText(row[detailKey]),
    });
  }
  return rows as
    | Array<{ name: string; warning: string }>
    | Array<{ name: string; reason: string }>;
}

function normalizeMigrationCompleteness(
  value: unknown,
):
  | NonNullable<MigrationVerificationReport["resource_completeness"]>
  | undefined
  | typeof INVALID_MIGRATION_VALUE {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 256) {
    return INVALID_MIGRATION_VALUE;
  }
  const rows: NonNullable<
    MigrationVerificationReport["resource_completeness"]
  > = [];
  const seenResources = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return INVALID_MIGRATION_VALUE;
    }
    const row = raw as Record<string, unknown>;
    const sourceTotal = safeMigrationCount(row.source_total);
    const imported = safeMigrationCount(row.imported);
    const notes = normalizeEvidenceStringArray(row.notes);
    if (
      typeof row.resource !== "string" ||
      !/^[a-z][a-z0-9_.:-]{0,127}$/u.test(row.resource) ||
      seenResources.has(row.resource) ||
      typeof row.label !== "string" ||
      typeof row.supported !== "boolean" ||
      typeof row.status !== "string" ||
      !MIGRATION_COMPLETENESS_STATUSES.has(row.status) ||
      sourceTotal === null ||
      imported === null ||
      !isConsistentMigrationCompletenessState(
        row.status,
        row.supported,
        sourceTotal,
        imported,
      ) ||
      notes === INVALID_MIGRATION_VALUE
    ) {
      return INVALID_MIGRATION_VALUE;
    }
    seenResources.add(row.resource);
    rows.push({
      resource: row.resource,
      label: safeMigrationEvidenceText(row.label),
      source_total: sourceTotal,
      imported,
      supported: row.supported,
      status: row.status,
      ...(notes === undefined ? {} : { notes }),
    });
  }
  return rows;
}

export function isConsistentMigrationCompletenessState(
  status: unknown,
  supported: unknown,
  sourceTotal: unknown,
  imported: unknown,
): boolean {
  const normalizedSourceTotal = safeMigrationCount(sourceTotal);
  const normalizedImported = safeMigrationCount(imported);
  if (
    typeof status !== "string" ||
    !MIGRATION_COMPLETENESS_STATUSES.has(status) ||
    typeof supported !== "boolean" ||
    normalizedSourceTotal === null ||
    normalizedImported === null
  ) {
    return false;
  }
  if (normalizedSourceTotal > 0 && normalizedImported > normalizedSourceTotal) {
    return false;
  }
  switch (status) {
    case "imported_runtime":
    case "preserved_for_rebuild":
      return (
        supported &&
        normalizedImported > 0 &&
        (normalizedSourceTotal === 0 ||
          normalizedImported === normalizedSourceTotal)
      );
    case "partial_runtime":
      return (
        supported &&
        normalizedSourceTotal > 0 &&
        normalizedImported < normalizedSourceTotal
      );
    case "manual_rebuild_required":
      return supported
        ? normalizedSourceTotal === 0
          ? normalizedImported === 0
          : normalizedImported < normalizedSourceTotal
        : true;
    case "not_supported":
      return !supported && normalizedSourceTotal > 0;
    case "not_detected":
      return normalizedSourceTotal === 0 && normalizedImported === 0;
    default:
      return false;
  }
}

function normalizeMigrationResourceWarnings(
  value: unknown,
):
  | NonNullable<MigrationVerificationReport["campaign_archive_warnings"]>
  | undefined
  | typeof INVALID_MIGRATION_VALUE {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1_000) {
    return INVALID_MIGRATION_VALUE;
  }
  const rows: NonNullable<
    MigrationVerificationReport["campaign_archive_warnings"]
  > = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return INVALID_MIGRATION_VALUE;
    }
    const row = raw as Record<string, unknown>;
    if (typeof row.resource !== "string" || typeof row.warning !== "string") {
      return INVALID_MIGRATION_VALUE;
    }
    if (row.source_id !== undefined && typeof row.source_id !== "string") {
      return INVALID_MIGRATION_VALUE;
    }
    if (row.name !== undefined && typeof row.name !== "string") {
      return INVALID_MIGRATION_VALUE;
    }
    rows.push({
      resource: safeMigrationEvidenceText(row.resource),
      warning: safeMigrationEvidenceText(row.warning),
      ...(typeof row.source_id === "string"
        ? { source_id: safeMigrationEvidenceText(row.source_id) }
        : {}),
      ...(typeof row.name === "string"
        ? { name: safeMigrationEvidenceText(row.name) }
        : {}),
    });
  }
  return rows;
}

function normalizeMigrationMergeConflicts(
  value: unknown,
):
  | NonNullable<MigrationVerificationReport["subscriber_merge_conflicts"]>
  | undefined
  | typeof INVALID_MIGRATION_VALUE {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1_000) {
    return INVALID_MIGRATION_VALUE;
  }
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return INVALID_MIGRATION_VALUE;
    }
    const row = raw as Record<string, unknown>;
    if (typeof row.email !== "string" || row.email.length > 512) {
      return INVALID_MIGRATION_VALUE;
    }
    for (const key of ["source_ids", "tags", "conflict_fields"] as const) {
      const parsed = normalizeEvidenceStringArray(row[key]);
      if (parsed === INVALID_MIGRATION_VALUE) return INVALID_MIGRATION_VALUE;
    }
  }
  // Only the bounded count is rendered. Subscriber identity is withheld.
  return value.map(() => ({ email: "withheld" }));
}

function normalizeMigrationCountRecord(
  value: unknown,
): Record<string, number> | undefined | typeof INVALID_MIGRATION_VALUE {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return INVALID_MIGRATION_VALUE;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 256) return INVALID_MIGRATION_VALUE;
  const counts: Record<string, number> = {};
  for (const [key, raw] of entries) {
    const count = safeMigrationCount(raw);
    if (!/^[a-z][a-z0-9_.:-]{0,127}$/u.test(key) || count === null) {
      return INVALID_MIGRATION_VALUE;
    }
    counts[key] = count;
  }
  return counts;
}

function normalizeSelectedAudienceIds(
  value: unknown,
): string[] | undefined | null {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 1_000) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = typeof item === "string" ? item.trim() : "";
    if (!id || id.length > 512 || seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function normalizeMigrationJobs(value: unknown): MigrationJob[] {
  const raw = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : [];
  return raw
    .map(normalizeMigrationJob)
    .filter((job): job is MigrationJob => job !== null)
    .sort(
      (left, right) =>
        (parseMigrationTime(right.started_at) ?? 0) -
        (parseMigrationTime(left.started_at) ?? 0),
    );
}

export function parseMigrationJobsPayload(
  value: unknown,
): { ok: true; jobs: MigrationJob[] } | { ok: false; error: RemoteApiError } {
  const raw = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : null;
  if (raw === null) {
    return {
      ok: false,
      error: {
        kind: "parse",
        code: "migration_jobs_invalid_envelope",
      },
    };
  }
  const jobs = normalizeMigrationJobs(raw);
  if (jobs.length !== raw.length) {
    return {
      ok: false,
      error: {
        kind: "parse",
        code: "migration_jobs_invalid_item",
      },
    };
  }
  return { ok: true, jobs };
}

export function countMigrations(jobs: MigrationJob[]): MigrationCounts {
  const counts: MigrationCounts = {
    all: 0,
    in_flight: 0,
    completed: 0,
    failed: 0,
    rolled_back: 0,
  };
  for (const job of jobs) {
    counts.all += 1;
    if (job.status === "completed") counts.completed += 1;
    else if (job.status === "failed") counts.failed += 1;
    else if (job.status === "rolled_back") counts.rolled_back += 1;
    else counts.in_flight += 1;
  }
  return counts;
}

export function filterMigrations(
  jobs: MigrationJob[],
  filter: MigrationStatusFilter,
): MigrationJob[] {
  if (filter === "all") return jobs;
  if (filter === "in_flight") {
    return jobs.filter((job) => isMigrationInFlight(job.status));
  }
  return jobs.filter((job) => job.status === filter);
}

export function migrationOverallProgress(
  progress?: MigrationProgress | null,
  source?: MigrationSource,
): number | null {
  if (!progress) return null;
  const buckets: Array<[number | undefined, number | undefined, number]> = [
    [progress.subscribers_done, progress.subscribers_total, 4],
    [progress.segments_done, progress.segments_total, 1],
    [progress.automations_done, progress.automations_total, 1],
    [progress.paid_subs_done, progress.paid_subs_total, 1],
    [progress.archive_done, progress.archive_total, 1],
    [progress.templates_done, progress.templates_total, 1],
    [progress.source_archive_done, progress.source_archive_total, 1],
  ];
  let weightedDone = 0;
  let totalWeight = 0;
  for (const [index, [rawDone, rawTotal, weight]] of buckets.entries()) {
    if (
      (source === "beehiiv" && (index === 2 || index === 3)) ||
      (source === "activecampaign" && index === 2) ||
      (source === "customerio" && (index === 2 || index === 3))
    ) {
      continue;
    }
    const done = finiteNonNegative(rawDone);
    const total = finiteNonNegative(rawTotal);
    if (done === undefined || total === undefined) continue;
    if (done > total) return null;
    if (total <= 0) continue;
    weightedDone += (done / total) * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return null;
  return Math.max(
    0,
    Math.min(100, Math.round((weightedDone / totalWeight) * 100)),
  );
}

export interface RollbackEligibility {
  allowed: boolean;
  reason: string;
  deadline: string | null;
}

export function migrationRollbackEligibility(
  job: MigrationJob,
  canAdmin: boolean,
  now = Date.now(),
): RollbackEligibility {
  if (!canAdmin) {
    return {
      allowed: false,
      reason: "Admin role required to roll back tenant data.",
      deadline: job.rollback_until ?? null,
    };
  }
  if (job.status !== "completed") {
    return {
      allowed: false,
      reason: "Rollback becomes available only after a migration completes.",
      deadline: job.rollback_until ?? null,
    };
  }
  const deadline = parseMigrationTime(job.rollback_until);
  if (deadline === null) {
    return {
      allowed: false,
      reason: "The server did not provide a verifiable rollback deadline.",
      deadline: null,
    };
  }
  if (deadline <= now) {
    return {
      allowed: false,
      reason: "The verified rollback window has closed.",
      deadline: new Date(deadline).toISOString(),
    };
  }
  return {
    allowed: true,
    reason: `Rollback is available until ${formatMigrationAbsoluteTime(deadline)}.`,
    deadline: new Date(deadline).toISOString(),
  };
}

/**
 * Re-decodes the authoritative job immediately before a destructive rollback.
 * The server remains the final authority for tracked writes and tenancy, but a
 * stale dialog can never send a request after the verified deadline or after
 * the job has already moved into another lifecycle generation.
 */
export function normalizeMigrationRollbackCandidate(
  value: unknown,
  expected: Pick<MigrationJob, "id" | "source">,
  now = Date.now(),
): MigrationJob | null {
  const job = normalizeMigrationJob(value);
  if (
    !job ||
    job.id !== expected.id ||
    job.source !== expected.source ||
    (job.status !== "completed" && job.status !== "failed")
  ) {
    return null;
  }
  const deadline = parseMigrationTime(job.rollback_until);
  return deadline !== null && deadline > now ? job : null;
}

export function migrationResourceLabel(
  resource: unknown,
  source?: MigrationSource,
): string {
  if (source === "customerio") {
    switch (resource) {
      case "segments":
        return "Frozen segment/topic snapshots";
      case "automations":
        return "Workflow rebuild evidence";
      case "archive":
        return "Sent email newsletter archive";
      case "templates":
        return "Editable Design Studio email templates";
      case "source_archive":
        return "Customer.io source evidence";
      case "paid_subs":
        return "Unsupported paid subscriptions";
    }
  }
  if (source === "hubspot" && resource === "segments") {
    return "List/subscription targeting boundaries";
  }
  switch (resource) {
    case "subscribers":
      return "Subscribers";
    case "segments":
      return "Segments";
    case "automations":
      return "Automations";
    case "paid_subs":
      return "Premium memberships";
    case "archive":
      return "Campaign archive";
    case "templates":
      return "Templates";
    case "source_archive":
      return "Source archive";
    case "all":
      return "All resources";
    default:
      return "Migration resources";
  }
}

export function isKnownMigrationResource(
  resource: unknown,
): resource is MigrationResource {
  return (
    typeof resource === "string" &&
    KNOWN_RESOURCES.has(resource as MigrationResource)
  );
}

export function mergeMigrationJob(
  current: MigrationJob,
  incoming: MigrationJob,
): MigrationJob {
  if (current.id !== incoming.id) return incoming;
  const acceptIncomingStatus = canAdvanceMigrationStatus(
    current.status,
    incoming.status,
    current.error,
  );
  const currentProgress =
    migrationOverallProgress(current.progress, current.source) ?? -1;
  const incomingProgress =
    migrationOverallProgress(incoming.progress, incoming.source) ?? -1;
  return {
    ...current,
    ...incoming,
    status: acceptIncomingStatus ? incoming.status : current.status,
    progress:
      incomingProgress >= currentProgress
        ? incoming.progress
        : current.progress,
    verification_report:
      incoming.verification_report ?? current.verification_report,
    completed_at: incoming.completed_at ?? current.completed_at,
    rollback_until: incoming.rollback_until ?? current.rollback_until,
    cursor: acceptIncomingStatus
      ? (incoming.cursor ?? current.cursor)
      : current.cursor,
    error: acceptIncomingStatus ? incoming.error : current.error,
  };
}

const MIGRATION_STAGE_ORDER: Readonly<Record<MigrationStatus, number>> = {
  pending: 0,
  authenticating: 1,
  discovering: 2,
  dry_run: 3,
  awaiting_confirmation: 4,
  importing: 5,
  completed: 6,
  failed: 6,
  rolling_back: 7,
  rolled_back: 8,
};

/**
 * Fail-closed fallback for deployments that do not yet emit a monotonic job
 * revision. It prevents ordinary stale list/SSE/poll snapshots from moving a
 * job backwards while retaining the two explicit operator-driven generations:
 * completed → rollback and cancelled → resumed import.
 */
export function canAdvanceMigrationStatus(
  current: MigrationStatus,
  incoming: MigrationStatus,
  currentError?: string | null,
): boolean {
  if (current === incoming) return true;
  if (current === "rolled_back") return false;
  if (current === "completed") {
    return incoming === "rolling_back" || incoming === "rolled_back";
  }
  if (current === "rolling_back") {
    return incoming === "rolled_back" || incoming === "failed";
  }
  if (current === "failed") {
    return /cancel/i.test(currentError ?? "") && incoming === "importing";
  }
  return MIGRATION_STAGE_ORDER[incoming] >= MIGRATION_STAGE_ORDER[current];
}

export function safeMigrationFailure(
  error: RemoteApiError,
  action: string,
): { message: string; detail: string; failure: RemoteFailure } {
  const failure = remoteFailureFromError(error);
  const references = [
    failure.code ? `code ${failure.code}` : null,
    failure.requestId ? `request ${failure.requestId}` : null,
  ].filter((value): value is string => value !== null);
  return {
    message: `${action} could not be confirmed.`,
    detail: `${failure.message}${references.length > 0 ? ` Reference: ${references.join(", ")}.` : ""}`,
    failure,
  };
}

export function safeMigrationOperationFailure(
  caught: unknown,
  action: string,
): { message: string; detail: string; failure: RemoteFailure } {
  return safeMigrationFailure(remoteErrorFromUnknown(caught), action);
}

export function safeMigrationOperationText(
  caught: unknown,
  action: string,
): string {
  const safe = safeMigrationOperationFailure(caught, action);
  return `${safe.message} ${safe.detail}`;
}

export interface NormalizedMigrationProgressEvent {
  resource: MigrationProgressEvent["resource"];
  completed: number;
  total: number;
  snapshot: MigrationProgress;
  at: string;
}

export function normalizeMigrationProgressEvent(
  value: unknown,
): NormalizedMigrationProgressEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const progress = normalizeMigrationProgress(event.snapshot);
  const completed = safeMigrationCount(event.completed);
  const total = safeMigrationCount(event.total);
  const at = normalizeMigrationTimestamp(event.at, false);
  if (
    !isKnownMigrationResource(event.resource) ||
    !progress ||
    !event.snapshot ||
    typeof event.snapshot !== "object" ||
    Array.isArray(event.snapshot) ||
    hasInvalidMigrationProgressField(event.snapshot) ||
    completed === null ||
    total === null ||
    completed > total ||
    typeof at !== "string"
  ) {
    return null;
  }
  return {
    resource: event.resource,
    completed,
    total,
    snapshot: progress,
    at,
  };
}

function remoteErrorFromUnknown(caught: unknown): RemoteApiError {
  if (!caught || typeof caught !== "object" || Array.isArray(caught)) {
    return { kind: "network" };
  }
  const candidate = caught as Partial<ApiErr["error"]>;
  const allowedKinds = new Set<NonNullable<RemoteApiError["kind"]>>([
    "http",
    "network",
    "offline",
    "storage",
    "timeout",
    "parse",
    "invalid_config",
  ]);
  return {
    ...(typeof candidate.status === "number" &&
    Number.isInteger(candidate.status)
      ? { status: candidate.status }
      : {}),
    ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
    ...(typeof candidate.requestId === "string"
      ? { requestId: candidate.requestId }
      : {}),
    ...(typeof candidate.kind === "string" &&
    allowedKinds.has(candidate.kind as NonNullable<RemoteApiError["kind"]>)
      ? { kind: candidate.kind as NonNullable<RemoteApiError["kind"]> }
      : { kind: "network" as const }),
  };
}

export function safeMigrationEvidenceText(value: unknown): string {
  if (typeof value !== "string") return "Review required";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "Review required";
  const redacted = normalized
    .replace(
      /\b(authorization|token|api[-_ ]?key|secret|password)\s*[:=]\s*(?:bearer\s+)?\S+/gi,
      "$1=[redacted]",
    )
    .replace(/\bbearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[external reference withheld]");
  return redacted.length > 240 ? `${redacted.slice(0, 237)}…` : redacted;
}
