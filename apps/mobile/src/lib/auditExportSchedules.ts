/**
 * lib/auditExportSchedules.ts — parsing + validation for recurring
 * evidence-pack exports (apps/api/internal/handlers/audit_export_schedules.go).
 *
 * Wire contract, read off the Go handlers:
 *
 *   GET    /api/v1/audit/export-schedules        → {schedules:[…]}   audit:read
 *   POST   /api/v1/audit/export-schedules        body {cadence, recipients, filters?}
 *   DELETE /api/v1/audit/export-schedules/{id}                       admin
 *
 * `validateExportScheduleInput` server-side demands cadence weekly|monthly and
 * 1..20 parseable recipient addresses (deduped case-insensitively); this
 * module mirrors those refusals so a body the server would 400 never leaves
 * the phone. The completed exports are MAILED by the schedule worker — unlike
 * the ad-hoc export, which the sheet must keep saying is collect-from-web.
 *
 * Import-free of react-native; asserted under node vitest.
 */
import { transitionLabel } from "./direction";

export const EXPORT_SCHEDULE_CADENCES = ["weekly", "monthly"] as const;
export type ExportScheduleCadence = (typeof EXPORT_SCHEDULE_CADENCES)[number];

/** Server bound (maxExportScheduleRecipients). */
export const MAX_EXPORT_SCHEDULE_RECIPIENTS = 20;

export interface AuditExportSchedule {
  id: string;
  cadence: string;
  recipients: string[];
  enabled: boolean;
  createdByEmail: string;
  lastEnqueuedAt: string | null;
  createdAt: string | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function timestamp(value: unknown): string | null {
  const raw = str(value);
  if (!raw || raw.startsWith("0001-01-01")) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

export function parseAuditExportSchedule(
  value: unknown,
): AuditExportSchedule | null {
  const row = (value ?? {}) as Record<string, unknown>;
  const id = str(row["id"]);
  if (!id) return null;
  const recipients = Array.isArray(row["recipients"])
    ? row["recipients"].filter((r): r is string => typeof r === "string")
    : [];
  return {
    id,
    cadence: str(row["cadence"]),
    recipients,
    enabled: row["enabled"] === true,
    createdByEmail: str(row["created_by_email"]),
    lastEnqueuedAt: timestamp(row["last_enqueued_at"]),
    createdAt: timestamp(row["created_at"]),
  };
}

export function parseAuditExportSchedules(
  payload: unknown,
): AuditExportSchedule[] {
  const body = (payload ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(body["schedules"]) ? body["schedules"] : [];
  return raw
    .map(parseAuditExportSchedule)
    .filter((s): s is AuditExportSchedule => s !== null);
}

/**
 * Split a typed recipient list on commas/whitespace, drop empties, dedupe
 * case-insensitively — mirroring the server's normalisation so what the
 * confirm shows is what the schedule stores.
 */
export function splitRecipients(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(/[\s,;]+/)) {
    const address = piece.trim();
    if (!address) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

/** A pragmatic mirror of mail.ParseAddress: local@domain.tld shape. */
function looksLikeEmail(address: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

/**
 * Every reason the server would refuse this input, in its own terms.
 * Empty errors = `buildExportScheduleBody` produces an acceptable body.
 */
export function validateExportScheduleInput(
  cadence: string,
  recipientsRaw: string,
): string[] {
  const errors: string[] = [];
  if (!EXPORT_SCHEDULE_CADENCES.includes(cadence as ExportScheduleCadence)) {
    errors.push("Pick a cadence — weekly or monthly.");
  }
  const recipients = splitRecipients(recipientsRaw);
  if (recipients.length === 0) {
    errors.push("At least one recipient email is required.");
  }
  if (recipients.length > MAX_EXPORT_SCHEDULE_RECIPIENTS) {
    errors.push(
      `At most ${MAX_EXPORT_SCHEDULE_RECIPIENTS} recipients per schedule.`,
    );
  }
  const invalid = recipients.find((r) => !looksLikeEmail(r));
  if (invalid) errors.push(`"${invalid}" is not an email address.`);
  return errors;
}

export interface ExportScheduleBody {
  cadence: string;
  recipients: string[];
}

/** The wire body, or null for input the validator refuses. */
export function buildExportScheduleBody(
  cadence: string,
  recipientsRaw: string,
): ExportScheduleBody | null {
  if (validateExportScheduleInput(cadence, recipientsRaw).length > 0) {
    return null;
  }
  return { cadence, recipients: splitRecipients(recipientsRaw) };
}

/** One sentence per schedule: cadence, recipients, and whether it has run. */
export function exportScheduleLine(schedule: AuditExportSchedule): string {
  const cadence =
    schedule.cadence === "weekly"
      ? "Weekly"
      : schedule.cadence === "monthly"
        ? "Monthly"
        : schedule.cadence || "Scheduled";
  const to =
    schedule.recipients.length === 1
      ? schedule.recipients[0]
      : `${schedule.recipients.length} recipients`;
  const ran = schedule.lastEnqueuedAt ? "" : " · has not run yet";
  const paused = schedule.enabled ? "" : " · paused";
  // The connector flips under an RTL layout; a baked-in "→" would leave the
  // recipients reading as the source. `String` only satisfies
  // noUncheckedIndexedAccess — the one-recipient branch always has an element.
  return `${transitionLabel(cadence, String(to))}${ran}${paused}`;
}
