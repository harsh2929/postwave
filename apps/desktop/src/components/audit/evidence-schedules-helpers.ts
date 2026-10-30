/**
 * evidence-schedules-helpers — pure logic for the audit evidence-pack
 * schedules UI (roadmap R10,
 * apps/api/internal/handlers/audit_export_schedules.go).
 *
 * Server contract:
 *   - cadence ∈ {weekly, monthly}; ≤ 10 recipients; 400 invalid_schedule.
 *   - list envelope is `{schedules}` (NOT items).
 *   - delete answers 200 `{deleted:true}` (NOT 204).
 *   - reads need audit:read; mutations need audit:configure_sinks.
 */

export const EVIDENCE_SCHEDULE_MAX_RECIPIENTS = 10;

export type EvidenceCadence = "weekly" | "monthly";

export const EVIDENCE_CADENCES: ReadonlyArray<{
  value: EvidenceCadence;
  label: string;
}> = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

// Pragmatic email shape check — final validation is server-side
// (invalid_schedule); this just catches typos before the round-trip.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RecipientsParse {
  /** De-duplicated (case-insensitive), order-preserving valid emails. */
  emails: string[];
  /** Tokens that don't look like emails — surfaced verbatim. */
  invalid: string[];
}

/**
 * Parse a comma/whitespace/semicolon-separated recipient string.
 * Duplicates collapse case-insensitively but keep the first spelling.
 */
export function parseRecipients(raw: string): RecipientsParse {
  const emails: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(/[\s,;]+/)) {
    if (!token) continue;
    if (!EMAIL_RE.test(token)) {
      invalid.push(token);
      continue;
    }
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(token);
  }
  return { emails, invalid };
}

/**
 * Pre-flight validation for the create form. Returns null when the
 * input is sendable, else the error copy to show inline.
 */
export function validateScheduleInput(
  cadence: string,
  parsed: RecipientsParse,
): string | null {
  if (cadence !== "weekly" && cadence !== "monthly") {
    return "Cadence must be weekly or monthly.";
  }
  if (parsed.invalid.length > 0) {
    return `Not a valid email: ${parsed.invalid.join(", ")}`;
  }
  if (parsed.emails.length === 0) {
    return "At least one recipient email is required.";
  }
  if (parsed.emails.length > EVIDENCE_SCHEDULE_MAX_RECIPIENTS) {
    return `At most ${EVIDENCE_SCHEDULE_MAX_RECIPIENTS} recipients per schedule.`;
  }
  return null;
}

/** One-line summary for a schedule row ("Weekly · 3 recipients"). */
export function scheduleSummary(
  cadence: string,
  recipients: readonly string[],
): string {
  const cadenceLabel =
    cadence === "weekly" ? "Weekly" : cadence === "monthly" ? "Monthly" : cadence;
  const n = recipients.length;
  return `${cadenceLabel} · ${n} recipient${n === 1 ? "" : "s"}`;
}
