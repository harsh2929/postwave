// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure countdown math backing the "Resend" cooldown on the check-your-email
// states (AUTH-010). No timers/DOM here so it unit-tests cleanly; the
// component drives it with a 1s interval and re-derives the remaining seconds
// from wall-clock timestamps (robust to backgrounded tabs / throttled timers).

/** How long the Resend action stays disabled after a send, in seconds. */
export const RESEND_COOLDOWN_SECONDS = 30;

/**
 * Whole seconds remaining until `endsAtMs`, clamped to [0, ∞). Rounds up so a
 * partially-elapsed final second still reads "1s" rather than "0s".
 */
export function remainingCooldownSeconds(
  nowMs: number,
  endsAtMs: number,
): number {
  const remainingMs = endsAtMs - nowMs;
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}
