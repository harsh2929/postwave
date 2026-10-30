/**
 * scheduledReports — the wire shape, the schedule grammar and the health
 * verdict for operator-defined recurring digest emails.
 *
 * WHY THIS EXISTS ON A PHONE AT ALL. Desktop wraps these in a 1,310-line
 * authoring section: naming a report, picking a template, composing a
 * timezone-aware recurrence, editing a recipient list. None of that is phone
 * work. But the question "this thing is emailing the exec team at the wrong
 * time / with an error — stop it" is asked away from a desk, and until now the
 * answer was "wait until you are back at a laptop".
 *
 * So the phone slice is exactly four verbs: SEE the schedules, see WHEN each
 * one next fires, PAUSE one, and SEND one now to check it looks right.
 *
 * TWO THINGS THIS MODULE REFUSES TO DO.
 *
 *  1. INVENT A SCHEDULE IT CANNOT PARSE. The server's grammar is
 *     `weekly:<dow>@HH:MM` / `monthly:<dom>@HH:MM`
 *     (apps/api/internal/scheduled_reports/scheduled_reports.go). Anything
 *     else — a grammar added server-side after this shipped — renders VERBATIM
 *     rather than as a confident mis-reading. A schedule line is the one
 *     string on this surface a user acts on.
 *  2. REPORT A RUN THAT DID NOT HAPPEN AS ZERO. The list query COALESCEs the
 *     per-run counters to 0, so a report that has never run comes back with
 *     `accepted_count: 0` — indistinguishable on the wire from a run that
 *     delivered to nobody. `latest_run_id` is the discriminator, and these
 *     counters are null (→ em-dash) without it.
 *
 * Free of react-native/expo — its only import is `lib/format`, which is
 * itself import-free — so all of the above is unit-tested rather than eyeballed.
 */
import { EMDASH, num, plural } from "./format";

export interface ScheduledReportRow {
  id: string;
  name: string;
  enabled: boolean;
  template: string;
  /** Raw server grammar. Render via `scheduleLabel`. */
  schedule: string;
  timezone: string;
  recipients: string[];
  /** ISO. Null when it has never run. */
  lastRunAt: string | null;
  /** "" when the last run was clean. */
  lastRunError: string;
  latestRunId: string | null;
  latestRunStatus: string | null;
  /** Null when there is no latest run — NOT zero. */
  acceptedCount: number | null;
  failedCount: number | null;
  recipientCount: number | null;
  /** ISO. Null when paused or when the server has not computed one. */
  nextDueAt: string | null;
}

export type ScheduledReportHealth = "failing" | "paused" | "due" | "scheduled";

const DOW: Readonly<Record<string, string>> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStr(value: unknown): string | null {
  const s = str(value).trim();
  return s === "" ? null : s;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(str).filter((entry) => entry.trim() !== "");
}

/**
 * Parse `GET /api/v1/scheduled-reports` → `{ reports: [...] }`.
 *
 * A row with no `id` is dropped rather than rendered with a blank key: every
 * action on this surface is addressed by id, and a row you cannot pause is
 * worse than a row you cannot see.
 */
export function parseScheduledReports(raw: unknown): ScheduledReportRow[] {
  const container = isRecord(raw) ? raw.reports : null;
  if (!Array.isArray(container)) return [];
  const out: ScheduledReportRow[] = [];
  for (const entry of container) {
    if (!isRecord(entry)) continue;
    const id = str(entry.id).trim();
    if (!id) continue;
    const latestRunId = nullableStr(entry.latest_run_id);
    out.push({
      id,
      name: str(entry.name).trim() || "Untitled report",
      enabled: entry.enabled === true,
      template: str(entry.template),
      schedule: str(entry.schedule),
      timezone: str(entry.timezone) || "UTC",
      recipients: strList(entry.recipients),
      lastRunAt: nullableStr(entry.last_run_at),
      lastRunError: str(entry.last_run_error),
      latestRunId,
      latestRunStatus: nullableStr(entry.latest_run_status),
      // Counters only mean anything alongside a run.
      acceptedCount: latestRunId ? int(entry.latest_run_accepted_count) : null,
      failedCount: latestRunId ? int(entry.latest_run_failed_count) : null,
      recipientCount: latestRunId
        ? int(entry.latest_run_recipient_count)
        : null,
      nextDueAt: nullableStr(entry.next_due_at),
    });
  }
  return out;
}

/**
 * `weekly:mon@09:00` → `Weekly on Monday at 09:00 UTC`.
 *
 * Anything the grammar does not cover is returned verbatim (with the timezone
 * appended when there is one), because a wrong schedule is worse than a
 * technical one.
 */
export function scheduleLabel(schedule: string, timezone: string): string {
  const raw = schedule.trim();
  const zone = timezone.trim();
  const suffix = zone ? ` ${zone}` : "";
  const match = /^(weekly|monthly):([a-z0-9]+)@(\d{2}:\d{2})$/iu.exec(raw);
  if (!match) return raw ? `${raw}${suffix}` : EMDASH;
  const [, kind, when, time] = match;
  if (!kind || !when || !time) return `${raw}${suffix}`;
  if (kind.toLowerCase() === "weekly") {
    const day = DOW[when.toLowerCase()];
    if (!day) return `${raw}${suffix}`;
    return `Weekly on ${day} at ${time}${suffix}`;
  }
  const dom = Number(when);
  if (!Number.isInteger(dom) || dom < 1 || dom > 28) return `${raw}${suffix}`;
  return `Monthly on day ${dom} at ${time}${suffix}`;
}

/**
 * The verdict, in the order an operator cares about it.
 *
 * "failing" beats "paused": a report someone paused BECAUSE it was failing
 * still needs the error on screen, or the pause looks like the fix.
 */
export function reportHealth(
  row: ScheduledReportRow,
  nowMs: number,
): ScheduledReportHealth {
  const failed =
    row.lastRunError.trim() !== "" ||
    row.latestRunStatus === "failed" ||
    (row.failedCount ?? 0) > 0;
  if (failed) return "failing";
  if (!row.enabled) return "paused";
  const due = row.nextDueAt ? Date.parse(row.nextDueAt) : Number.NaN;
  if (Number.isFinite(due) && due <= nowMs) return "due";
  return "scheduled";
}

/** One line under the name: what happened last, or what happens next. */
export function reportStatusLine(
  row: ScheduledReportRow,
  nowMs: number,
): string {
  const health = reportHealth(row, nowMs);
  if (health === "failing") {
    return row.lastRunError.trim() || "The last run failed.";
  }
  if (health === "paused") return "Paused — it will not send.";
  if (row.acceptedCount === null) return "Has not run yet.";
  const delivered = plural(row.acceptedCount, "recipient");
  if ((row.failedCount ?? 0) > 0) {
    return `Last run: ${delivered}, ${num(row.failedCount)} failed.`;
  }
  return `Last run: ${delivered}.`;
}

/**
 * Sort order: what is broken, then what fires soonest, then what is switched
 * off. The server returns `created_at DESC` — authoring order, which is the
 * one ordering that never matches why anyone opens this list.
 */
export function sortScheduledReports(
  rows: readonly ScheduledReportRow[],
  nowMs: number,
): ScheduledReportRow[] {
  const rank: Record<ScheduledReportHealth, number> = {
    failing: 0,
    due: 1,
    scheduled: 2,
    paused: 3,
  };
  // Array.isArray, not a nullish guard: a TRUTHY non-array payload passes
  // `?? []` at the call site and then throws here. Matches
  // sortIdempotencyKeys, which already guarded this way; api-keys shipped the
  // unguarded version as "Invalid attempt to spread non-iterable instance".
  const list: readonly ScheduledReportRow[] = Array.isArray(rows) ? rows : [];
  return [...list].sort((a, b) => {
    const ra = rank[reportHealth(a, nowMs)];
    const rb = rank[reportHealth(b, nowMs)];
    if (ra !== rb) return ra - rb;
    const da = a.nextDueAt ? Date.parse(a.nextDueAt) : Number.POSITIVE_INFINITY;
    const db = b.nextDueAt ? Date.parse(b.nextDueAt) : Number.POSITIVE_INFINITY;
    const na = Number.isFinite(da) ? da : Number.POSITIVE_INFINITY;
    const nb = Number.isFinite(db) ? db : Number.POSITIVE_INFINITY;
    if (na !== nb) return na - nb;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The confirm sheet for pausing / resuming.
 *
 * Pausing is stated as a CONSEQUENCE ("nobody receives the Monday digest"),
 * not as a state change ("enabled → false"), because the operator is deciding
 * about the recipients, not about a boolean.
 */
export function pauseConfirmCopy(row: ScheduledReportRow): {
  title: string;
  message: string;
  confirmLabel: string;
  consequence: string;
  destructive: boolean;
} {
  if (row.enabled) {
    return {
      title: `Pause “${row.name}”?`,
      message: `${scheduleLabel(row.schedule, row.timezone)}. Pausing takes effect immediately.`,
      confirmLabel: "Pause",
      consequence: `${recipientsSummary(row)} stop receiving it until it is resumed.`,
      destructive: true,
    };
  }
  return {
    title: `Resume “${row.name}”?`,
    message: `It will send again on its schedule: ${scheduleLabel(
      row.schedule,
      row.timezone,
    )}.`,
    confirmLabel: "Resume",
    consequence: `${recipientsSummary(row)} start receiving it again.`,
    destructive: false,
  };
}

/** The confirm sheet for send-now. */
export function sendNowConfirmCopy(row: ScheduledReportRow): {
  title: string;
  message: string;
  confirmLabel: string;
  consequence: string;
} {
  return {
    title: `Send “${row.name}” now?`,
    message:
      "This queues one extra run immediately. It does not change the schedule or skip the next one.",
    confirmLabel: "Send now",
    consequence: `${recipientsSummary(row)} receive a real email.`,
  };
}

/** "3 recipients" / "ops@acme.com" — named when there is only one. */
export function recipientsSummary(row: ScheduledReportRow): string {
  if (row.recipients.length === 0) return "No recipients";
  if (row.recipients.length === 1) return row.recipients[0] ?? "One recipient";
  return plural(row.recipients.length, "recipient");
}

/**
 * The whole row as one sentence, for VoiceOver. Compacted figures elsewhere on
 * the row are spelled out here — a screen-reader user must not be the only one
 * who cannot hear the exact numbers.
 */
export function scheduledReportSpoken(
  row: ScheduledReportRow,
  nowMs: number,
  nextDueLabel: string,
): string {
  const health = reportHealth(row, nowMs);
  const state =
    health === "failing"
      ? "failing"
      : health === "paused"
        ? "paused"
        : health === "due"
          ? "due now"
          : "scheduled";
  return [
    row.name,
    `${state}.`,
    `${scheduleLabel(row.schedule, row.timezone)}.`,
    row.enabled ? `Next run ${nextDueLabel}.` : "",
    `${recipientsSummary(row)}.`,
    reportStatusLine(row, nowMs),
  ]
    .filter(Boolean)
    .join(" ");
}
