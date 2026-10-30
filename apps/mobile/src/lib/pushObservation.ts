/**
 * lib/pushObservation.ts — the two pure decisions behind push health telemetry.
 *
 * Split out of `lib/push.ts` (NATIVE#54) because both of them exist to stop a
 * privacy or honesty regression and neither could be tested where it lived:
 *
 *   - `pushErrorCode` is what lets us report WHY registration failed without
 *     shipping the exception. An error message from the push stack can contain
 *     an Expo token, a device name, or a URL with a session in it; the bucket
 *     name never can. Everything unrecognised collapses to one deliberately
 *     coarse bucket rather than leaking a fallback string.
 *
 *   - `boundedHealthDuration` clamps a wall-clock delta. A device whose clock
 *     jumps backwards mid-registration (timezone change, NTP correction, a
 *     user setting the date) otherwise reports a negative or absurd duration
 *     that poisons every percentile it lands in.
 */

/** A day. Longer than any plausible registration; anything past it is a clock. */
export const MAX_PUSH_HEALTH_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Bucket a push failure into a coarse, non-identifying code.
 *
 * The buckets are chosen so each one implies a different remedy: `authorization`
 * means sign in again, `rate_limit` means wait, `server` means it is not the
 * user's fault, and `native_or_network` covers everything from a simulator
 * without APNs to a lost radio.
 */
export function pushErrorCode(error: unknown): string {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (status === 401 || status === 403) return "authorization";
  if (status === 429) return "rate_limit";
  if (typeof status === "number" && status >= 500) return "server";
  return "native_or_network";
}

/** Clamp an elapsed-time reading to a sane, non-negative window. */
export function boundedHealthDuration(
  startedAt: number,
  now: number = Date.now(),
): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return 0;
  return Math.min(MAX_PUSH_HEALTH_DURATION_MS, Math.max(0, now - startedAt));
}
