/**
 * lib/sendWindowVerdict.ts — POST /api/v1/send-window/check, as data rules.
 *
 * The wire shape is send_window.go's Verdict:
 *   {inside_window: bool, enforcement: string, should: "allow"|"warn"|"block",
 *    reason?: string}
 *
 * The copy mirrors desktop's send-checklist-helpers.ts (sendWindowRowDetail /
 * sendWindowRowStatus) so the same verdict reads the same on both devices —
 * with one mobile-specific addition: the "no policy" case renders NOTHING
 * rather than a line, because a schedule sheet that announces the absence of
 * a policy on every open is noise, where desktop's checklist row is a list
 * entry that has to say something.
 */

export type SendWindowShould = "allow" | "warn" | "block";

/**
 * Truncate the picked instant to the MINUTE before it becomes part of a query
 * key: the wheel emits second-level values while it settles, and a key that
 * moves per second would refetch a policy evaluation whose answer cannot
 * differ within the minute. Null for an invalid date — the check then never
 * fires.
 */
export function sendWindowCheckInstant(picked: Date): string | null {
  const ms = picked.getTime();
  if (Number.isNaN(ms)) return null;
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}

export interface SendWindowVerdict {
  insideWindow: boolean;
  enforcement: string;
  should: SendWindowShould;
  reason: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Null on an unparseable body — the sheet then says nothing, never guesses. */
export function parseSendWindowVerdict(
  payload: unknown,
): SendWindowVerdict | null {
  const body = record(payload);
  const should = body["should"];
  if (should !== "allow" && should !== "warn" && should !== "block") {
    return null;
  }
  return {
    insideWindow: body["inside_window"] === true,
    enforcement:
      typeof body["enforcement"] === "string" ? body["enforcement"] : "",
    should,
    reason: typeof body["reason"] === "string" ? body["reason"].trim() : "",
  };
}

export type SendWindowTone = "ok" | "warning" | "danger";

export function sendWindowTone(verdict: SendWindowVerdict): SendWindowTone {
  if (verdict.should === "block") return "danger";
  if (verdict.should === "warn") return "warning";
  return "ok";
}

/**
 * The one line under the time picker, or null when there is nothing worth
 * saying (no policy / enforcement off — the picker's silence is the answer).
 */
export function sendWindowLine(verdict: SendWindowVerdict): string | null {
  if (verdict.insideWindow) {
    if (verdict.enforcement === "off" || verdict.enforcement === "") {
      return null;
    }
    return "Inside your workspace's send window.";
  }
  const reason = verdict.reason ? ` (${verdict.reason})` : "";
  if (verdict.should === "block") {
    return `Outside the send window — this send would be blocked${reason}. Pick a time inside the window.`;
  }
  if (verdict.should === "warn") {
    return `Outside the send window — policy warns${reason}. It will still send.`;
  }
  return null;
}
