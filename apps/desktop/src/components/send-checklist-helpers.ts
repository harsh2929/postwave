/**
 * send-checklist-helpers — pure logic behind the three client-side
 * SendChecklist rows added by the full-surface wiring pass
 * (accessibility / link check / send window) and the send-window
 * policy editor modal.
 *
 * High-stakes invariants:
 *   1. Weekday numbering matches Go `time.Weekday` (0=Sunday ..
 *      6=Saturday) and the bitmap convention in
 *      apps/api/internal/send_window/send_window.go: bit `1<<i` set
 *      means weekday i is allowed. The server default is 126
 *      (Mon–Sat). Sending ISO 1..7 days would shift every window.
 *   2. Row statuses reuse the server checklist's pass/warn/fail
 *      vocabulary so the pills render through the same `statusPill`.
 *   3. The send-window verdict mapping mirrors the server's `should`
 *      field (allow|warn|block) rather than re-deriving it from the
 *      policy — the server owns the enforcement semantics.
 */

import type {
  A11yReport,
  LinkCheckResult,
  SendWindowVerdict,
} from "../lib/api-client";

export type ChecklistRowStatus = "pass" | "warn" | "fail";

/* ------- accessibility ------------------------------------------------ */

/** errors → fail, warnings → warn, otherwise pass. */
export function a11yRowStatus(report: A11yReport): ChecklistRowStatus {
  if (report.counts.error > 0) return "fail";
  if (report.counts.warn > 0) return "warn";
  return "pass";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function a11yRowDetail(report: A11yReport): string {
  const parts: string[] = [`Score ${Math.round(report.score)}/100`];
  if (report.counts.error > 0) parts.push(plural(report.counts.error, "error"));
  if (report.counts.warn > 0) parts.push(plural(report.counts.warn, "warning"));
  if (report.counts.error === 0 && report.counts.warn === 0) {
    parts.push(
      report.counts.info > 0
        ? plural(report.counts.info, "info note")
        : "no findings",
    );
  }
  return parts.join(" · ");
}

/* ------- link check --------------------------------------------------- */

/** Any broken link fails the row; an empty body passes (nothing to break). */
export function linksRowStatus(results: LinkCheckResult[]): ChecklistRowStatus {
  return results.some((r) => !r.ok) ? "fail" : "pass";
}

export function linksRowDetail(results: LinkCheckResult[]): string {
  if (results.length === 0) return "No links found in the body.";
  const broken = results.filter((r) => !r.ok).length;
  if (broken === 0) {
    return `${plural(results.length, "link")} checked — all reachable.`;
  }
  return `${broken} of ${plural(results.length, "link")} broken.`;
}

/** Human label for one link verdict's status column. */
export function linkStatusLabel(row: LinkCheckResult): string {
  if (row.status > 0) return String(row.status);
  return row.error ? "error" : "—";
}

/* ------- send window --------------------------------------------------- */

export function sendWindowRowStatus(
  verdict: SendWindowVerdict,
): ChecklistRowStatus {
  if (verdict.should === "block") return "fail";
  if (verdict.should === "warn") return "warn";
  return "pass";
}

export function sendWindowRowDetail(verdict: SendWindowVerdict): string {
  if (verdict.inside_window) {
    return verdict.enforcement === "off"
      ? "No send-window policy is enforced."
      : "Inside the configured send window.";
  }
  const reason = verdict.reason ? ` (${verdict.reason})` : "";
  if (verdict.should === "block") {
    return `Outside the send window — sends are blocked${reason}.`;
  }
  return `Outside the send window — policy warns${reason}.`;
}

/* ------- weekday bitmap (Go time.Weekday: 0=Sun .. 6=Sat) ------------- */

export const WEEKDAY_LABELS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

/** Server default: Monday through Saturday (bits 1..6). */
export const DEFAULT_WEEKDAY_BITMAP = 126;

export function bitmapHasDay(bitmap: number, day: number): boolean {
  if (day < 0 || day > 6) return false;
  return (bitmap & (1 << day)) !== 0;
}

export function toggleWeekday(bitmap: number, day: number): number {
  if (day < 0 || day > 6) return bitmap;
  return bitmap ^ (1 << day);
}

/** "Mon, Tue, Wed" style label; "No days" when empty. */
export function weekdaysLabel(bitmap: number): string {
  const days = WEEKDAY_LABELS.filter((_, i) => bitmapHasDay(bitmap, i));
  return days.length > 0 ? days.join(", ") : "No days";
}

/** PUT /send-window validation, mirrored client-side for inline errors. */
export function validateSendWindowForm(form: {
  startLocal: string;
  endLocal: string;
  bitmap: number;
}): string | null {
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hhmm.test(form.startLocal)) return "Start time must be HH:MM.";
  if (!hhmm.test(form.endLocal)) return "End time must be HH:MM.";
  if (form.endLocal <= form.startLocal) {
    return "End time must be after start time.";
  }
  if (form.bitmap <= 0 || form.bitmap > 127) {
    return "Pick at least one weekday.";
  }
  return null;
}
