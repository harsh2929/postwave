/**
 * Pure helpers for the Analytics "Scheduled reports" section (#31).
 *
 * Render-free so it unit-tests under the node vitest environment.
 * Wire shapes verified against apps/api/internal/scheduled_reports:
 *
 *   - template ∈ engagement_summary | deliverability | growth
 *     (empty defaults server-side to engagement_summary)
 *   - schedule is a compact string: "weekly:mon@09:00" or
 *     "monthly:14@09:00" (day-of-month 1..28 only — the server
 *     rejects 29-31 so February never skips a report)
 *   - timezone is UTC or a valid IANA location (for example Asia/Kolkata)
 *   - recipients is a non-empty string[] of 1–20 mailbox addresses
 *   - send-now creates a durable run receipt; queued never means delivered
 */

import type {
  ScheduledReportApiError,
  ScheduledReport,
  ScheduledReportCreateInput,
  ScheduledReportPatchInput,
  ScheduledReportRunStatus,
  ScheduledReportSendNowReceipt,
} from "../lib/api-client";

/* ---------- catalog constants ---------- */

export const REPORT_TEMPLATES = [
  {
    value: "engagement_summary",
    label: "Engagement summary",
    description: "Opens, clicks, and replies across the period",
  },
  {
    value: "deliverability",
    label: "Deliverability",
    description: "Bounces, complaints, and inbox-health signals",
  },
  {
    value: "growth",
    label: "Growth",
    description: "Subscriber adds, unsubs, and source quality",
  },
] as const;

export const WEEKDAYS = [
  { value: "mon", label: "Monday" },
  { value: "tue", label: "Tuesday" },
  { value: "wed", label: "Wednesday" },
  { value: "thu", label: "Thursday" },
  { value: "fri", label: "Friday" },
  { value: "sat", label: "Saturday" },
  { value: "sun", label: "Sunday" },
] as const;

export const COMMON_TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;

/* ---------- schedule string ↔ structured parts ---------- */

export interface ScheduleParts {
  kind: "weekly" | "monthly";
  /** Weekday key when kind=weekly ("mon".."sun"). */
  dow: string;
  /** Day-of-month "1".."28" when kind=monthly. */
  dom: string;
  /** "HH:MM" 24h. */
  time: string;
}

export const DEFAULT_SCHEDULE: ScheduleParts = {
  kind: "weekly",
  dow: "mon",
  dom: "1",
  time: "09:00",
};

const TIME_RE = /^(\d{1,2}):(\d{1,2})$/;

/** Parse the wire schedule ("weekly:mon@09:00"). Returns null on any
 *  shape the editor can't round-trip — the caller falls back to a raw
 *  text input so an invalid legacy value can be repaired deliberately. */
export function parseSchedule(s: string | undefined): ScheduleParts | null {
  if (!s) return null;
  const colon = s.indexOf(":");
  if (colon < 0) return null;
  const kind = s.slice(0, colon).toLowerCase();
  const rest = s.slice(colon + 1);
  const at = rest.indexOf("@");
  if (at < 0) return null;
  const target = rest.slice(0, at).toLowerCase();
  const time = rest.slice(at + 1);
  const timeMatch = TIME_RE.exec(time);
  if (!timeMatch) return null;
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (hour > 23 || minute > 59) return null;
  const normTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (kind === "weekly") {
    if (!WEEKDAYS.some((w) => w.value === target)) return null;
    return { kind: "weekly", dow: target, dom: "1", time: normTime };
  }
  if (kind === "monthly") {
    const n = Number(target);
    if (!Number.isInteger(n) || n < 1 || n > 28) return null;
    return { kind: "monthly", dow: "mon", dom: String(n), time: normTime };
  }
  return null;
}

export function composeSchedule(p: ScheduleParts): string {
  return p.kind === "weekly"
    ? `weekly:${p.dow}@${p.time}`
    : `monthly:${p.dom}@${p.time}`;
}

/** "weekly:mon@09:00" → "Weekly · Mon @ 09:00". Unknown shapes are
 *  echoed verbatim — never pretend we understood something we didn't. */
export function humanizeSchedule(s: string | undefined): string {
  const p = parseSchedule(s);
  if (!p) return s || "—";
  if (p.kind === "weekly") {
    const day = WEEKDAYS.find((w) => w.value === p.dow)?.label ?? p.dow;
    return `Weekly on ${day} at ${p.time}`;
  }
  return `Monthly on day ${p.dom} at ${p.time}`;
}

/* ---------- timezone ---------- */

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export function deviceTimezone(): string {
  try {
    const candidate = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimezone(candidate) ? candidate : "UTC";
  } catch {
    return "UTC";
  }
}

export function timezoneSuggestions(): string[] {
  return Array.from(new Set([deviceTimezone(), ...COMMON_TIMEZONES]));
}

export function normalizeTimezone(value: string | undefined): string {
  return value?.trim() || "UTC";
}

/** Mirrors the server's public timezone contract without maintaining a
 * second timezone database in the renderer. */
export function isValidTimezone(value: string | undefined): boolean {
  const timezone = normalizeTimezone(value);
  if (
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

export function timezonePolicyCopy(timezone: string | undefined): string {
  const zone = normalizeTimezone(timezone);
  return `${zone} wall-clock time. During fall-back, the first occurrence is used; during spring-forward, a missing time moves to the first valid minute.`;
}

export function formatReportDateTime(
  value: string | null | undefined,
  timezone: string | undefined,
  locale?: string,
): string {
  if (!value) return "Not scheduled";
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return "Unavailable";
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: isValidTimezone(timezone) ? normalizeTimezone(timezone) : "UTC",
      month: "short",
      day: "numeric",
      year:
        instant.getUTCFullYear() === new Date().getUTCFullYear()
          ? undefined
          : "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(instant);
  } catch {
    return "Unavailable";
  }
}

/* ---------- recipients ---------- */

/** Split a textarea of emails on commas / whitespace / newlines,
 *  trim, drop empties, and dedupe case-insensitively (first spelling
 *  wins). */
export function parseRecipients(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const v = raw.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function invalidRecipients(list: string[]): string[] {
  return list.filter((e) => !EMAIL_RE.test(e));
}

/* ---------- editor draft ---------- */

export interface ReportDraft {
  name: string;
  template: string;
  schedule: ScheduleParts;
  /** Raw schedule string when the wire value didn't round-trip
   *  through the structured editor (kept verbatim, edited as text). */
  rawSchedule: string | null;
  timezone: string;
  recipientsText: string;
  enabled: boolean;
}

export function draftFromReport(r?: ScheduledReport | null): ReportDraft {
  const parsed = r ? parseSchedule(r.schedule) : { ...DEFAULT_SCHEDULE };
  return {
    name: r?.name ?? "",
    template: r?.template ?? "engagement_summary",
    schedule: parsed ?? { ...DEFAULT_SCHEDULE },
    rawSchedule: r && !parsed ? r.schedule : null,
    timezone: normalizeTimezone(r?.timezone ?? deviceTimezone()),
    recipientsText: (r?.recipients ?? []).join("\n"),
    enabled: r?.enabled ?? true,
  };
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function draftErrors(d: ReportDraft): Record<string, string> {
  const e: Record<string, string> = {};
  const name = d.name.trim();
  if (!name) {
    e.name = "Name is required";
  } else if (utf8Length(name) > 160 || CONTROL_RE.test(name)) {
    e.name = "Use 160 bytes or fewer and remove control characters";
  }
  if (!REPORT_TEMPLATES.some((template) => template.value === d.template)) {
    e.template = "Choose a supported report template";
  }
  const recipients = parseRecipients(d.recipientsText);
  if (recipients.length === 0) {
    e.recipients = "At least one recipient email is required";
  } else if (recipients.length > 20) {
    e.recipients = "A scheduled report can have at most 20 recipients";
  } else {
    const bad = invalidRecipients(recipients);
    if (bad.length > 0) {
      e.recipients = `${bad.length} recipient entr${bad.length === 1 ? "y isn't" : "ies aren't"} a valid mailbox address`;
    } else if (recipients.some((recipient) => utf8Length(recipient) > 320)) {
      e.recipients = "Each recipient address must be 320 bytes or fewer";
    }
  }
  if (!isValidTimezone(d.timezone)) {
    e.timezone = 'Use UTC or a valid IANA timezone such as "America/New_York"';
  }
  if (d.rawSchedule != null) {
    if (!parseSchedule(d.rawSchedule.trim())) {
      e.schedule =
        'Schedule must look like "weekly:mon@09:00" or "monthly:14@09:00" (day 1–28)';
    }
  } else {
    const timeMatch = TIME_RE.exec(d.schedule.time);
    const validTime = Boolean(
      timeMatch && Number(timeMatch[1]) <= 23 && Number(timeMatch[2]) <= 59,
    );
    const validTarget =
      (d.schedule.kind === "weekly" &&
        WEEKDAYS.some((weekday) => weekday.value === d.schedule.dow)) ||
      (d.schedule.kind === "monthly" &&
        Number.isInteger(Number(d.schedule.dom)) &&
        Number(d.schedule.dom) >= 1 &&
        Number(d.schedule.dom) <= 28);
    if (!validTarget || !validTime) {
      e.schedule =
        "Choose a supported weekly or monthly cadence and a valid 24-hour time";
    }
  }
  return e;
}

const REPORT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_STATUSES = new Set<string>([
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

function isWireDate(value: unknown): value is string;
function isWireDate(
  value: unknown,
  optional: true,
): value is string | null | undefined;
function isWireDate(
  value: unknown,
  optional = false,
): value is string | null | undefined {
  if (optional && (value === undefined || value === null)) return true;
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

function isWireCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 20
  );
}

/**
 * Fail-closed decoder for the recipient-bearing list response.
 *
 * The generic HTTP client cannot prove this route's domain invariants at
 * runtime. Decode before retaining or rendering anything so malformed
 * recipient data, invented delivery outcomes, and unknown status values never
 * become trusted UI. Legacy `last_run_error` text is intentionally discarded.
 */
export function decodeScheduledReports(
  value: unknown,
): ScheduledReport[] | null {
  if (!Array.isArray(value)) return null;
  const decoded: ScheduledReport[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const recipients = candidate.recipients;
    const accepted = candidate.latest_run_accepted_count;
    const failed = candidate.latest_run_failed_count;
    const unknown = candidate.latest_run_unknown_count;
    const recipientCount = candidate.latest_run_recipient_count;
    const latestRunID = candidate.latest_run_id;
    const latestRunStatus = candidate.latest_run_status;
    const latestRunCreatedAt = candidate.latest_run_created_at;
    const hasRun = typeof latestRunID === "string" && latestRunID.length > 0;

    if (
      typeof candidate.id !== "string" ||
      !REPORT_ID_RE.test(candidate.id) ||
      typeof candidate.name !== "string" ||
      !candidate.name.trim() ||
      candidate.name !== candidate.name.trim() ||
      utf8Length(candidate.name.trim()) > 160 ||
      CONTROL_RE.test(candidate.name) ||
      typeof candidate.enabled !== "boolean" ||
      typeof candidate.template !== "string" ||
      !REPORT_TEMPLATES.some(
        (template) => template.value === candidate.template,
      ) ||
      typeof candidate.schedule !== "string" ||
      parseSchedule(candidate.schedule) === null ||
      typeof candidate.timezone !== "string" ||
      !isValidTimezone(candidate.timezone) ||
      candidate.timezone !== normalizeTimezone(candidate.timezone) ||
      !Array.isArray(recipients) ||
      recipients.length < 1 ||
      recipients.length > 20 ||
      !recipients.every(
        (recipient) =>
          typeof recipient === "string" &&
          utf8Length(recipient) <= 320 &&
          !CONTROL_RE.test(recipient) &&
          invalidRecipients([recipient]).length === 0,
      ) ||
      new Set(recipients.map((recipient) => String(recipient).toLowerCase()))
        .size !== recipients.length ||
      !isWireCount(accepted) ||
      !isWireCount(failed) ||
      !isWireCount(unknown) ||
      !isWireCount(recipientCount) ||
      accepted + failed + unknown > recipientCount ||
      !isWireDate(candidate.created_at) ||
      !isWireDate(candidate.next_due_at, true) ||
      !isWireDate(candidate.last_run_at, true) ||
      (candidate.last_run_error !== undefined &&
        typeof candidate.last_run_error !== "string") ||
      (hasRun
        ? !REPORT_ID_RE.test(latestRunID) ||
          typeof latestRunStatus !== "string" ||
          !RUN_STATUSES.has(latestRunStatus) ||
          !isWireDate(latestRunCreatedAt)
        : (latestRunID !== undefined && latestRunID !== null) ||
          (latestRunStatus !== undefined && latestRunStatus !== null) ||
          (latestRunCreatedAt !== undefined && latestRunCreatedAt !== null) ||
          accepted !== 0 ||
          failed !== 0 ||
          unknown !== 0 ||
          recipientCount !== 0)
    ) {
      return null;
    }

    decoded.push({
      id: candidate.id,
      name: candidate.name,
      enabled: candidate.enabled,
      template: candidate.template,
      schedule: candidate.schedule,
      timezone: candidate.timezone,
      recipients: [...recipients] as string[],
      last_run_at:
        typeof candidate.last_run_at === "string"
          ? candidate.last_run_at
          : null,
      latest_run_id: hasRun ? latestRunID : null,
      latest_run_status: hasRun
        ? (latestRunStatus as ScheduledReportRunStatus)
        : null,
      latest_run_created_at:
        hasRun && typeof latestRunCreatedAt === "string"
          ? latestRunCreatedAt
          : null,
      latest_run_accepted_count: accepted,
      latest_run_failed_count: failed,
      latest_run_unknown_count: unknown,
      latest_run_recipient_count: recipientCount,
      next_due_at:
        typeof candidate.next_due_at === "string"
          ? candidate.next_due_at
          : null,
      created_at: candidate.created_at,
    });
  }
  return decoded;
}

export function draftSchedule(d: ReportDraft): string {
  return d.rawSchedule != null
    ? d.rawSchedule.trim()
    : composeSchedule(d.schedule);
}

export function draftToCreateInput(d: ReportDraft): ScheduledReportCreateInput {
  return {
    name: d.name.trim(),
    template: d.template,
    schedule: draftSchedule(d),
    timezone: normalizeTimezone(d.timezone),
    recipients: parseRecipients(d.recipientsText),
  };
}

/** Patch payload for an edit. The PATCH endpoint accepts name /
 *  schedule / recipients / enabled (template is create-only on the
 *  wire — the editor disables that field in edit mode). */
export function draftToPatchInput(d: ReportDraft): ScheduledReportPatchInput {
  return {
    name: d.name.trim(),
    schedule: draftSchedule(d),
    timezone: normalizeTimezone(d.timezone),
    recipients: parseRecipients(d.recipientsText),
    enabled: d.enabled,
  };
}

/* ---------- display ---------- */

export function templateLabel(value: string): string {
  return REPORT_TEMPLATES.find((t) => t.value === value)?.label ?? value;
}

export interface RunStatusPresentation {
  label: string;
  tone: "neutral" | "active" | "success" | "warning" | "danger";
  explanation: string;
  terminal: boolean;
}

const RUN_STATUS_PRESENTATION: Record<
  ScheduledReportRunStatus,
  RunStatusPresentation
> = {
  queued: {
    label: "Queued",
    tone: "neutral",
    explanation: "The durable run exists and is waiting for a worker.",
    terminal: false,
  },
  leased: {
    label: "Preparing",
    tone: "active",
    explanation: "A worker has claimed the run and is preparing its snapshot.",
    terminal: false,
  },
  delivering: {
    label: "Requesting acceptance",
    tone: "active",
    explanation: "Recipient requests are in progress.",
    terminal: false,
  },
  succeeded: {
    label: "Accepted",
    tone: "success",
    explanation:
      "The provider confirmed acceptance for every recipient. Inbox placement is not guaranteed.",
    terminal: true,
  },
  partial: {
    label: "Partially accepted",
    tone: "warning",
    explanation:
      "Some recipients were accepted and others were rejected or skipped.",
    terminal: true,
  },
  failed: {
    label: "Not accepted",
    tone: "danger",
    explanation: "No recipient delivery was confirmed.",
    terminal: true,
  },
  needs_review: {
    label: "Needs review",
    tone: "warning",
    explanation:
      "At least one provider outcome is unknown. It will not be retried automatically.",
    terminal: true,
  },
};

export function runStatusPresentation(
  status: string | null | undefined,
): RunStatusPresentation {
  if (status && status in RUN_STATUS_PRESENTATION) {
    return RUN_STATUS_PRESENTATION[status as ScheduledReportRunStatus];
  }
  return {
    label: "No run yet",
    tone: "neutral",
    explanation: "No durable delivery run has been created for this report.",
    terminal: false,
  };
}

export interface ScheduledReportOutcome {
  accepted: number;
  failed: number;
  unknown: number;
  pending: number;
  total: number;
}

function safeCount(value: number | null | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value ?? 0)
    : 0;
}

export function reportOutcome(report: ScheduledReport): ScheduledReportOutcome {
  const accepted = safeCount(report.latest_run_accepted_count);
  const failed = safeCount(report.latest_run_failed_count);
  const unknown = safeCount(report.latest_run_unknown_count);
  const classified = accepted + failed + unknown;
  const total = Math.max(
    classified,
    safeCount(report.latest_run_recipient_count),
  );
  return {
    accepted,
    failed,
    unknown,
    pending: Math.max(0, total - classified),
    total,
  };
}

export function isAmbiguousSendNowError(
  error: ScheduledReportApiError,
): boolean {
  if (
    error.kind === "network" ||
    error.kind === "timeout" ||
    error.kind === "parse"
  ) {
    return true;
  }
  return (
    error.status === 408 ||
    error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
  );
}

export type ScheduledReportAction =
  | "load"
  | "create"
  | "update"
  | "delete"
  | "send";

/** User-safe domain copy. Backend/provider messages are deliberately never
 * returned from this helper. */
export function scheduledReportErrorMessage(
  error: ScheduledReportApiError,
  action: ScheduledReportAction,
): string {
  if (error.status === 401) {
    return "Your session is no longer authorized. Sign in again to continue.";
  }
  if (error.status === 403) {
    return "Scheduled report delivery is available to workspace admins only.";
  }
  if (error.status === 404) {
    return "This scheduled report no longer exists. Refresh the list.";
  }
  if (error.status === 409 || error.code === "report_configuration_invalid") {
    return "Correct the report name, schedule, timezone, and recipients before queuing a run.";
  }
  if (error.status === 400 || error.status === 413 || error.status === 422) {
    return action === "send"
      ? "The run request was rejected before it could be queued."
      : "Review the highlighted report settings and try again.";
  }
  if (isAmbiguousSendNowError(error) && action === "send") {
    return "The queue response could not be confirmed. Retry this same request to recover its original run without creating another.";
  }
  if (error.kind === "network" || error.kind === "timeout") {
    return "The service could not be reached. Check the connection and retry.";
  }
  return action === "load"
    ? "Scheduled report evidence could not be verified. Retry when ready."
    : "The scheduled report action could not be completed. Try again.";
}

export function safeScheduledReportDiagnostic(
  error: ScheduledReportApiError,
): string | null {
  const token = (error.requestId || error.code || "").trim();
  return token && token.length <= 96 && /^[A-Za-z0-9._:-]+$/.test(token)
    ? token
    : null;
}

/** Honest send-now toast: 202 creates a durable queued run; it does not
 * prove any recipient request or inbox delivery. */
export function sendNowMessage(
  r: ScheduledReport,
  receipt: ScheduledReportSendNowReceipt,
): string {
  const n = r.recipients.length;
  const run = receipt.run_id.slice(0, 8);
  return `Run ${run} queued for ${n} recipient${n === 1 ? "" : "s"}. Queued means awaiting processing, not delivered.`;
}
