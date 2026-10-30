/**
 * appLockGrace — how long an app-lock unlock survives a trip to another app.
 *
 * The gate treated every non-active AppState transition as a re-authentication
 * event. That is correct for the PRIVACY COVER (iOS captures the app-switcher
 * thumbnail on `inactive`, so the content must be hidden before then), but it
 * conflated the cover with the auth requirement: switching to an authenticator
 * to read a 2FA code — the single most common reason a Moosewave user leaves
 * the app — cost a full Face ID prompt on return, two seconds later.
 *
 * Two rules make a grace period safe rather than merely convenient:
 *
 *   1. The COVER IS UNCONDITIONAL. The grace period decides whether the user
 *      is re-PROMPTED, never whether the content is hidden. A backgrounded app
 *      is always covered, at zero grace, forever.
 *   2. DEFAULT IS ZERO. Anyone who armed the app lock chose today's behaviour;
 *      silently loosening it would be a security regression applied to people
 *      who never asked for it. The grace is strictly opt-in.
 *
 * This module is deliberately import-free so the policy is testable in the
 * node environment (`expo-secure-store` and `react-native` are not).
 */

/** Options offered in Settings, in ascending order of exposure. */
export const APP_LOCK_GRACE_CHOICES = [0, 60, 300, 900] as const;

export type AppLockGraceSeconds = (typeof APP_LOCK_GRACE_CHOICES)[number];

/** Never trust a stored or hostile value to hold the lock open for a day. */
export const MAX_APP_LOCK_GRACE_SECONDS = 900;

export const DEFAULT_APP_LOCK_GRACE_SECONDS = 0;

/**
 * Coerce anything that comes back from storage into a supported choice.
 * A corrupted value must collapse to the SAFEST option (0 = prompt every
 * time), never to the most permissive one.
 */
export function normalizeGraceSeconds(value: unknown): AppLockGraceSeconds {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{1,5}$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const capped = Math.min(Math.trunc(raw), MAX_APP_LOCK_GRACE_SECONDS);
  // Snap DOWN to the nearest offered choice: rounding up would grant more
  // exposure than any option the user could have picked.
  let chosen: AppLockGraceSeconds = 0;
  for (const choice of APP_LOCK_GRACE_CHOICES) {
    if (choice <= capped) chosen = choice;
  }
  return chosen;
}

/**
 * Should returning to the foreground demand authentication again?
 *
 * @param backgroundedAtMs when the app last left the foreground; null when it
 *   never did (a fresh arm), which always requires authentication.
 * @param nowMs            current clock.
 * @param graceSeconds     the user's chosen grace window.
 */
export function shouldRepromptOnForeground(
  backgroundedAtMs: number | null,
  nowMs: number,
  graceSeconds: number,
): boolean {
  const grace = normalizeGraceSeconds(graceSeconds);
  if (grace <= 0) return true;
  if (backgroundedAtMs === null || !Number.isFinite(backgroundedAtMs)) {
    return true;
  }
  const elapsedMs = nowMs - backgroundedAtMs;
  // A clock that moved BACKWARDS (user changed the device time, NTP step) is
  // not evidence that little time passed. Fail closed and re-prompt.
  if (elapsedMs < 0) return true;
  return elapsedMs > grace * 1000;
}

/** Label for the Settings picker and its accessibility name. */
export function graceLabel(seconds: AppLockGraceSeconds): string {
  switch (seconds) {
    case 0:
      return "Immediately";
    case 60:
      return "After 1 min";
    case 300:
      return "After 5 min";
    default:
      return "After 15 min";
  }
}

/** Spoken description — a picker of bare durations says nothing on its own. */
export function graceAccessibilityLabel(seconds: AppLockGraceSeconds): string {
  return seconds === 0
    ? "Ask for authentication immediately on return"
    : `Ask for authentication after ${
        seconds === 60 ? "1 minute" : `${seconds / 60} minutes`
      } away`;
}
