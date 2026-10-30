// SPDX-License-Identifier: AGPL-3.0-only

import { api, ApiError } from "@/lib/api";
import { newUUIDv7 } from "@/lib/http-fetch";

export const SCHEDULED_REPORT_TEMPLATES = [
  "engagement_summary",
  "deliverability",
  "growth",
] as const;

export type ScheduledReportTemplate =
  (typeof SCHEDULED_REPORT_TEMPLATES)[number];

export type ScheduledReportRunStatus =
  | "queued"
  | "leased"
  | "delivering"
  | "succeeded"
  | "partial"
  | "failed"
  | "needs_review";

export interface ScheduledReport {
  id: string;
  name: string;
  enabled: boolean;
  template: ScheduledReportTemplate;
  schedule: string;
  timezone: string;
  recipients: string[];
  lastRunAt: string | null;
  latestRunId: string | null;
  latestRunStatus: ScheduledReportRunStatus | null;
  latestRunCreatedAt: string | null;
  latestRunAcceptedCount: number;
  latestRunFailedCount: number;
  latestRunUnknownCount: number;
  latestRunRecipientCount: number;
  nextDueAt: string | null;
  createdAt: string;
}

export interface ScheduledReportsSnapshot {
  /**
   * The route omits tenant_id. This client-side binding records the exact
   * authenticated workspace under which the private recipient-bearing read
   * was requested; callers must still re-check identity before every write.
   */
  tenantId: string;
  observedAt: string;
  reports: ScheduledReport[];
}

export interface ScheduledReportCreateInput {
  name: string;
  template: ScheduledReportTemplate;
  schedule: string;
  timezone: string;
  recipients: string[];
}

export interface ScheduledReportPatchInput {
  name: string;
  enabled: boolean;
  schedule: string;
  timezone: string;
  recipients: string[];
}

export interface ScheduledReportCreateReceipt {
  id: string;
  nextDueAt: string;
  timezone: string;
}

export interface ScheduledReportSendNowReceipt {
  queued: true;
  runId: string;
  scheduledReportId: string;
  runKind: "manual";
  status: "queued";
  occurrenceAt: string;
  createdAt: string;
}

export interface ScheduleParts {
  kind: "weekly" | "monthly";
  weekday: (typeof WEEKDAYS)[number];
  dayOfMonth: number;
  time: string;
}

export const WEEKDAYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;

export const DEFAULT_SCHEDULE_PARTS: ScheduleParts = {
  kind: "weekly",
  weekday: "mon",
  dayOfMonth: 1,
  time: "09:00",
};

export class ScheduledReportContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledReportContractError";
  }
}

export class ScheduledReportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledReportInputError";
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const MAX_REPORTS = 1_000;
const MAX_RECIPIENTS = 20;
const RUN_STATUSES = new Set<ScheduledReportRunStatus>([
  "queued",
  "leased",
  "delivering",
  "succeeded",
  "partial",
  "failed",
  "needs_review",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isWireTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    !value.startsWith("0001-01-01") &&
    Number.isFinite(Date.parse(value))
  );
}

function nullableTimestamp(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return isWireTimestamp(value) ? value : undefined;
}

function isMailboxShape(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8Length(value) > 320 ||
    CONTROL_RE.test(value) ||
    /\s/u.test(value)
  ) {
    return false;
  }
  const at = value.lastIndexOf("@");
  return at > 0 && at < value.length - 1;
}

export function parseScheduleParts(value: string): ScheduleParts | null {
  const weekly =
    /^weekly:(mon|tue|wed|thu|fri|sat|sun)@((?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(
      value,
    );
  if (weekly) {
    return {
      kind: "weekly",
      weekday: weekly[1] as ScheduleParts["weekday"],
      dayOfMonth: 1,
      time: weekly[2],
    };
  }
  const monthly = /^monthly:(\d{1,2})@((?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(
    value,
  );
  if (!monthly) return null;
  const day = Number(monthly[1]);
  if (!Number.isInteger(day) || day < 1 || day > 28) return null;
  return {
    kind: "monthly",
    weekday: "mon",
    dayOfMonth: day,
    time: monthly[2],
  };
}

export function composeSchedule(parts: ScheduleParts): string {
  if (!TIME_RE.test(parts.time)) {
    throw new ScheduledReportInputError("Choose a valid 24-hour report time.");
  }
  if (parts.kind === "weekly") {
    if (!WEEKDAYS.includes(parts.weekday)) {
      throw new ScheduledReportInputError("Choose a supported weekday.");
    }
    return `weekly:${parts.weekday}@${parts.time}`;
  }
  if (
    !Number.isInteger(parts.dayOfMonth) ||
    parts.dayOfMonth < 1 ||
    parts.dayOfMonth > 28
  ) {
    throw new ScheduledReportInputError(
      "Monthly reports must use a day from 1 through 28.",
    );
  }
  return `monthly:${parts.dayOfMonth}@${parts.time}`;
}

export function parseRecipientDraft(value: string): string[] {
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const raw of value.split(/[\s,;]+/u)) {
    const recipient = raw.trim();
    if (!recipient) continue;
    const key = recipient.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(recipient);
  }
  return recipients;
}

export function isValidTimezone(value: string): boolean {
  const timezone = value.trim();
  if (
    !timezone ||
    timezone.length > 64 ||
    CONTROL_RE.test(timezone) ||
    (timezone !== "UTC" && !timezone.includes("/"))
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (!name || utf8Length(name) > 160 || CONTROL_RE.test(name)) {
    throw new ScheduledReportInputError(
      "Report name must contain 1 to 160 bytes and no control characters.",
    );
  }
  return name;
}

function normalizeRecipients(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const recipient = raw.trim();
    if (!isMailboxShape(recipient)) {
      throw new ScheduledReportInputError(
        "Every recipient must be a valid mailbox address of at most 320 bytes.",
      );
    }
    const key = recipient.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(recipient);
  }
  if (out.length < 1 || out.length > MAX_RECIPIENTS) {
    throw new ScheduledReportInputError(
      "Provide between 1 and 20 unique recipient addresses.",
    );
  }
  return out;
}

function normalizeSharedInput<
  T extends ScheduledReportCreateInput | ScheduledReportPatchInput,
>(input: T): T {
  const schedule = input.schedule.trim();
  if (schedule.length > 80 || parseScheduleParts(schedule) === null) {
    throw new ScheduledReportInputError(
      "Use a weekly schedule such as weekly:mon@09:00 or a monthly day from 1 to 28.",
    );
  }
  const timezone = input.timezone.trim() || "UTC";
  if (!isValidTimezone(timezone)) {
    throw new ScheduledReportInputError(
      "Use UTC or a valid IANA timezone such as Asia/Kolkata.",
    );
  }
  return {
    ...input,
    name: normalizeName(input.name),
    schedule,
    timezone,
    recipients: normalizeRecipients(input.recipients),
  };
}

export function normalizeScheduledReportCreateInput(
  input: ScheduledReportCreateInput,
): ScheduledReportCreateInput {
  if (!SCHEDULED_REPORT_TEMPLATES.includes(input.template)) {
    throw new ScheduledReportInputError("Choose a supported report template.");
  }
  return normalizeSharedInput(input);
}

export function normalizeScheduledReportPatchInput(
  input: ScheduledReportPatchInput,
): ScheduledReportPatchInput {
  return normalizeSharedInput(input);
}

function parseReport(value: unknown): ScheduledReport {
  if (!isRecord(value)) {
    throw new ScheduledReportContractError(
      "A scheduled report row is not an object.",
    );
  }
  const recipients = value.recipients;
  const template = value.template;
  const status = value.latest_run_status;
  const latestRunId = value.latest_run_id;
  const latestRunCreatedAt = nullableTimestamp(value.latest_run_created_at);
  const lastRunAt = nullableTimestamp(value.last_run_at);
  const nextDueAt = nullableTimestamp(value.next_due_at);
  const counts = [
    value.latest_run_accepted_count,
    value.latest_run_failed_count,
    value.latest_run_unknown_count,
    value.latest_run_recipient_count,
  ];
  const hasRun = latestRunId !== undefined && latestRunId !== null;

  if (
    !isUuid(value.id) ||
    typeof value.name !== "string" ||
    value.name !== value.name.trim() ||
    !value.name ||
    utf8Length(value.name) > 160 ||
    CONTROL_RE.test(value.name) ||
    typeof value.enabled !== "boolean" ||
    typeof template !== "string" ||
    !SCHEDULED_REPORT_TEMPLATES.includes(template as ScheduledReportTemplate) ||
    typeof value.schedule !== "string" ||
    value.schedule.length > 80 ||
    parseScheduleParts(value.schedule) === null ||
    typeof value.timezone !== "string" ||
    value.timezone !== value.timezone.trim() ||
    !isValidTimezone(value.timezone) ||
    !Array.isArray(recipients) ||
    recipients.length < 1 ||
    recipients.length > MAX_RECIPIENTS ||
    !recipients.every(isMailboxShape) ||
    new Set(recipients.map((recipient) => recipient.toLowerCase())).size !==
      recipients.length ||
    !counts.every(
      (count) =>
        typeof count === "number" &&
        Number.isInteger(count) &&
        count >= 0 &&
        count <= MAX_RECIPIENTS,
    ) ||
    (counts[0] as number) + (counts[1] as number) + (counts[2] as number) >
      (counts[3] as number) ||
    !isWireTimestamp(value.created_at) ||
    lastRunAt === undefined ||
    nextDueAt === undefined ||
    latestRunCreatedAt === undefined ||
    (value.last_run_error !== undefined &&
      (typeof value.last_run_error !== "string" ||
        utf8Length(value.last_run_error) > 512))
  ) {
    throw new ScheduledReportContractError(
      "The scheduled report response failed its bounded wire contract.",
    );
  }

  if (
    hasRun
      ? !isUuid(latestRunId) ||
        typeof status !== "string" ||
        !RUN_STATUSES.has(status as ScheduledReportRunStatus) ||
        latestRunCreatedAt === null
      : (status !== undefined && status !== null) ||
        latestRunCreatedAt !== null ||
        counts.some((count) => count !== 0)
  ) {
    throw new ScheduledReportContractError(
      "The scheduled report latest-run evidence is internally inconsistent.",
    );
  }

  return {
    id: value.id,
    name: value.name,
    enabled: value.enabled,
    template: template as ScheduledReportTemplate,
    schedule: value.schedule,
    timezone: value.timezone,
    recipients: [...recipients],
    lastRunAt,
    latestRunId: hasRun ? (latestRunId as string) : null,
    latestRunStatus: hasRun ? (status as ScheduledReportRunStatus) : null,
    latestRunCreatedAt,
    latestRunAcceptedCount: counts[0] as number,
    latestRunFailedCount: counts[1] as number,
    latestRunUnknownCount: counts[2] as number,
    latestRunRecipientCount: counts[3] as number,
    nextDueAt,
    createdAt: value.created_at,
  };
}

export function parseScheduledReportsEnvelope(
  value: unknown,
  tenantId: string,
): ScheduledReportsSnapshot {
  if (!isUuid(tenantId)) {
    throw new ScheduledReportInputError(
      "A canonical workspace identity is required for scheduled reports.",
    );
  }
  if (!isRecord(value) || !Array.isArray(value.reports)) {
    throw new ScheduledReportContractError(
      "The scheduled report response did not contain a reports array.",
    );
  }
  if (value.reports.length > MAX_REPORTS) {
    throw new ScheduledReportContractError(
      `The unpaginated scheduled report response exceeded ${MAX_REPORTS} rows.`,
    );
  }
  const reports = value.reports.map(parseReport);
  if (new Set(reports.map((report) => report.id)).size !== reports.length) {
    throw new ScheduledReportContractError(
      "The scheduled report response contained duplicate identifiers.",
    );
  }
  return {
    tenantId,
    observedAt: new Date().toISOString(),
    reports,
  };
}

export async function listScheduledReports(
  tenantId: string,
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<ScheduledReportsSnapshot> {
  const value = await api.get<unknown>("/api/v1/scheduled-reports", {
    signal: options.signal,
    cache: "no-store",
    requireOnline: true,
    ...(options.fresh ? { maxAttempts: 1 } : {}),
  });
  return parseScheduledReportsEnvelope(value, tenantId);
}

function parseCreateReceipt(value: unknown): ScheduledReportCreateReceipt {
  if (
    !isRecord(value) ||
    !isUuid(value.id) ||
    !isWireTimestamp(value.next_due_at) ||
    typeof value.timezone !== "string" ||
    value.timezone !== value.timezone.trim() ||
    !isValidTimezone(value.timezone)
  ) {
    throw new ScheduledReportContractError(
      "The create response did not contain a valid scheduled-report receipt.",
    );
  }
  return {
    id: value.id,
    nextDueAt: value.next_due_at,
    timezone: value.timezone,
  };
}

export async function createScheduledReport(
  input: ScheduledReportCreateInput,
  options: { signal?: AbortSignal } = {},
): Promise<ScheduledReportCreateReceipt> {
  const normalized = normalizeScheduledReportCreateInput(input);
  const value = await api.post<unknown>(
    "/api/v1/scheduled-reports",
    normalized,
    {
      signal: options.signal,
      requireOnline: true,
      maxAttempts: 1,
    },
  );
  return parseCreateReceipt(value);
}

export async function updateScheduledReport(
  id: string,
  input: ScheduledReportPatchInput,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (!isUuid(id))
    throw new ScheduledReportInputError("Invalid report identity.");
  const normalized = normalizeScheduledReportPatchInput(input);
  const value = await api.patch<unknown>(
    `/api/v1/scheduled-reports/${encodeURIComponent(id)}`,
    normalized,
    {
      signal: options.signal,
      requireOnline: true,
      maxAttempts: 1,
    },
  );
  if (!isRecord(value) || value.updated !== true) {
    throw new ScheduledReportContractError(
      "The update response did not confirm the scheduled report write.",
    );
  }
}

export async function deleteScheduledReport(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (!isUuid(id))
    throw new ScheduledReportInputError("Invalid report identity.");
  const value = await api.delete<unknown>(
    `/api/v1/scheduled-reports/${encodeURIComponent(id)}`,
    {
      signal: options.signal,
      requireOnline: true,
      maxAttempts: 1,
    },
  );
  if (!isRecord(value) || value.deleted !== true) {
    throw new ScheduledReportContractError(
      "The delete response did not confirm scheduled report removal.",
    );
  }
}

export function newScheduledReportRunKey(): string {
  return newUUIDv7();
}

function validIdempotencyKey(value: string): boolean {
  return (
    value === value.trim() &&
    value.length > 0 &&
    utf8Length(value) <= 255 &&
    !CONTROL_RE.test(value)
  );
}

export async function sendScheduledReportNow(
  id: string,
  idempotencyKey: string,
  options: { signal?: AbortSignal } = {},
): Promise<ScheduledReportSendNowReceipt> {
  if (!isUuid(id))
    throw new ScheduledReportInputError("Invalid report identity.");
  if (!validIdempotencyKey(idempotencyKey)) {
    throw new ScheduledReportInputError(
      "A stable, bounded request identity is required for send-now.",
    );
  }
  const value = await api.post<unknown>(
    `/api/v1/scheduled-reports/${encodeURIComponent(id)}/send-now`,
    undefined,
    {
      signal: options.signal,
      requireOnline: true,
      maxAttempts: 1,
      idempotencyKey,
    },
  );
  if (
    !isRecord(value) ||
    value.queued !== true ||
    !isUuid(value.run_id) ||
    value.scheduled_report_id !== id ||
    value.run_kind !== "manual" ||
    value.status !== "queued" ||
    !isWireTimestamp(value.occurrence_at) ||
    !isWireTimestamp(value.created_at)
  ) {
    throw new ScheduledReportContractError(
      "The send-now response did not contain a valid durable queue receipt.",
    );
  }
  return {
    queued: true,
    runId: value.run_id,
    scheduledReportId: value.scheduled_report_id,
    runKind: "manual",
    status: "queued",
    occurrenceAt: value.occurrence_at,
    createdAt: value.created_at,
  };
}

/**
 * The route has no ETag or updated_at. This exact public configuration
 * comparison is the strongest available stale-editor check; worker-owned run
 * and next-due evidence is deliberately excluded because it can change while
 * an operator reviews an otherwise unchanged definition.
 */
export function sameScheduledReportConfiguration(
  left: ScheduledReport,
  right: ScheduledReport,
): boolean {
  return (
    left.id === right.id &&
    left.createdAt === right.createdAt &&
    left.name === right.name &&
    left.enabled === right.enabled &&
    left.template === right.template &&
    left.schedule === right.schedule &&
    left.timezone === right.timezone &&
    left.recipients.length === right.recipients.length &&
    left.recipients.every(
      (recipient, index) => recipient === right.recipients[index],
    )
  );
}

export function reportMatchesPatch(
  report: ScheduledReport,
  patch: ScheduledReportPatchInput,
): boolean {
  const normalized = normalizeScheduledReportPatchInput(patch);
  return (
    report.name === normalized.name &&
    report.enabled === normalized.enabled &&
    report.schedule === normalized.schedule &&
    report.timezone === normalized.timezone &&
    report.recipients.length === normalized.recipients.length &&
    report.recipients.every(
      (recipient, index) => recipient === normalized.recipients[index],
    )
  );
}

export function isAmbiguousScheduledReportRunError(error: unknown): boolean {
  return (
    error instanceof ScheduledReportContractError ||
    (error instanceof ApiError &&
      (error.kind === "network" ||
        error.kind === "timeout" ||
        error.kind === "parse" ||
        error.status === 408 ||
        error.status === 429 ||
        error.status >= 500))
  );
}
