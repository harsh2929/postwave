/**
 * Pure helpers for the Trigger delay preferences card (#29).
 *
 * The wire shape (TriggerDelayPreference) keys a preference on the
 * (subscriber_id, event_name) pair; the optimal delay is bounded
 * 0..2 592 000 seconds (30 days) server-side. We mirror that bound
 * locally so the form can reject out-of-range values before the PUT.
 */

/** Server-enforced upper bound: 30 days in seconds. */
export const MAX_DELAY_SECONDS = 2_592_000;
export const MAX_TRIGGER_DELAY_EVENT_NAME_BYTES = 256;
export const MAX_TRIGGER_DELAY_REASON_BYTES = 500;

export interface DelayLookupDraft {
  subscriberId: string;
  eventName: string;
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCanonicalSubscriberUUID(value: string): boolean {
  return CANONICAL_UUID.test(value.trim());
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function delayLookupErrors(d: DelayLookupDraft): Record<string, string> {
  const e: Record<string, string> = {};
  const subscriberId = d.subscriberId.trim();
  if (!subscriberId) {
    e.subscriberId = "Subscriber ID is required";
  } else if (!isCanonicalSubscriberUUID(subscriberId)) {
    e.subscriberId = "Subscriber ID must be a canonical UUID";
  }
  const eventName = d.eventName.trim();
  if (!eventName) {
    e.eventName = "Event name is required";
  } else if (utf8ByteLength(eventName) > MAX_TRIGGER_DELAY_EVENT_NAME_BYTES) {
    e.eventName = "Event name must be 256 bytes or fewer";
  }
  return e;
}

export function triggerDelayReasonError(reason: string): string | null {
  return utf8ByteLength(reason.trim()) > MAX_TRIGGER_DELAY_REASON_BYTES
    ? "Operator reason must be 500 bytes or fewer"
    : null;
}

export type ParsedDelay =
  | { ok: true; seconds: number }
  | { ok: false; error: string };

/**
 * Parse the operator-typed delay (seconds, as string from a controlled
 * input). Whole seconds only; 0 is valid ("send immediately").
 */
export function parseDelaySeconds(raw: string): ParsedDelay {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, error: "Delay is required" };
  const n = Number(trimmed);
  if (!Number.isInteger(n)) {
    return { ok: false, error: "Delay must be a whole number of seconds" };
  }
  if (n < 0) return { ok: false, error: "Delay can't be negative" };
  if (n > MAX_DELAY_SECONDS) {
    return {
      ok: false,
      error: `Delay can't exceed ${MAX_DELAY_SECONDS.toLocaleString()} seconds (30 days)`,
    };
  }
  return { ok: true, seconds: n };
}

/** Humanize a delay: 0 → "immediately", 5400 → "1h 30m (5,400s)". */
export function fmtDelay(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds === 0) return "immediately";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  return `${parts.join(" ")} (${seconds.toLocaleString()}s)`;
}

/**
 * Confidence as a percentage string. The server stores 0..1; values
 * already > 1 are assumed to be percentages and passed through (the
 * UI must not double-scale if the backend ever changes units).
 */
export function fmtConfidence(confidence: number): string {
  if (!Number.isFinite(confidence) || confidence < 0) return "—";
  const pct = confidence <= 1 ? confidence * 100 : confidence;
  return `${Math.round(pct)}%`;
}
