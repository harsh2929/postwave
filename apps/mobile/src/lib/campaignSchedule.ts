/**
 * lib/campaignSchedule.ts — the schedule sheet's pure logic.
 *
 * Two real defects lived in the sheet's inline code:
 *
 *  1. TWO CLOCKS, ONE LABEL. DateTimeWheel builds a Date in DEVICE-local
 *     time and the confirmation line was a bare `picked.toLocaleString()`
 *     with no zone suffix — sitting directly under a send-time recommendation
 *     formatted as "9:00 AM UTC". An operator in Lisbon scheduling a US
 *     workspace's send could not tell which "9:00" they had picked.
 *  2. A STALE PAST-TIME GUARD. `isPast` was computed during render and never
 *     recomputed as wall-clock time advanced, and the save handler re-read the
 *     same stale value. Pick 14:00 at 13:59, get interrupted, tap Save at
 *     14:05 — the client guard passes. Backgrounding and resuming, the most
 *     common phone interaction pattern, made it trivially reachable.
 */
import { dateTime, time } from "@/lib/format";

/** Grace period matching the gateway's own tolerance for clock skew. */
export const SCHEDULE_PAST_GRACE_MS = 60_000;

/** The device's IANA zone, or null when the runtime cannot report one. */
export function resolvedTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone.length > 0 ? zone : null;
  } catch {
    return null;
  }
}

/**
 * Whether a picked time is in the past. Takes `now` explicitly so the caller
 * can re-evaluate against a FRESH clock at save time rather than trusting a
 * value captured during an earlier render.
 */
export function isScheduleInPast(picked: Date, now: number): boolean {
  const at = picked.getTime();
  if (!Number.isFinite(at)) return true;
  return at < now - SCHEDULE_PAST_GRACE_MS;
}

/**
 * The confirmation line under the picker — always zone-qualified, so it can
 * never be confused with the UTC recommendation above it.
 */
export function scheduleConfirmLine(
  picked: Date,
  zone: string | null = resolvedTimeZone(),
): string {
  const rendered = dateTime(picked);
  return zone ? `Will send: ${rendered} (${zone})` : `Will send: ${rendered}`;
}

/**
 * The local-clock equivalent of a UTC send-time recommendation.
 *
 * The recommendation renders as e.g. "9:00 AM UTC" and sits directly above a
 * picker that works in DEVICE-local time. Applying it moves the wheel to the
 * local equivalent, which for anyone outside UTC is a different-looking
 * number — so the banner has to say what that number will be.
 *
 * Returns null when the two are the same clock, so a UTC device isn't told
 * "9:00 AM UTC (9:00 AM your time)".
 */
export function localEquivalentLabel(
  iso: string | null | undefined,
  zone: string | null = resolvedTimeZone(),
): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  if (at.getUTCHours() === at.getHours() && at.getUTCDate() === at.getDate()) {
    return null;
  }
  const rendered = time(at, "");
  if (!rendered) return null;
  return zone ? `${rendered} ${zone}` : `${rendered} your time`;
}

/**
 * Warning shown when the campaign was configured on desktop for per-recipient
 * send-time optimization. Writing a single fixed `scheduled_at` over that
 * configuration silently discards it, so the sheet has to say so.
 */
export function personalizedSendWarning(campaign: {
  per_recipient_optimize?: boolean | undefined;
}): string | null {
  if (!campaign.per_recipient_optimize) return null;
  return "This campaign is set to send at each recipient's best time. Saving a fixed time here replaces that setting — reconfigure it on the web app if you undo this.";
}
