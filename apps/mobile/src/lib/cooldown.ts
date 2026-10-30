/**
 * cooldown — the arithmetic behind every "Resend in 0:24" button.
 *
 * Magic-link start and password-reset start both sit behind
 * `AuthBruteforceLimiter` (apps/api/internal/server/identity_api.go), and the
 * resend buttons had no cooldown at all — their only disabled condition was
 * the in-flight flag. Email is slow, so users tap Resend three times in ten
 * seconds and earn themselves a five-minute lockout with no explanation.
 *
 * The state is kept as an absolute deadline rather than a decrementing
 * counter: a decrementing counter drifts when the app is backgrounded (the JS
 * timer stops), and would let a user return to a button that says "Resend in
 * 0:03" forever. Reading the deadline against the clock is correct across
 * suspend/resume.
 */

/** Default self-imposed gap between resends, well inside the server's window. */
export const DEFAULT_RESEND_COOLDOWN_SECONDS = 30;

export interface CooldownState {
  /** Epoch ms at which the action re-arms; 0 when there is no cooldown. */
  readyAt: number;
}

export const NO_COOLDOWN: CooldownState = { readyAt: 0 };

export function startCooldown(
  seconds: number = DEFAULT_RESEND_COOLDOWN_SECONDS,
  nowMs: number = Date.now(),
): CooldownState {
  if (!Number.isFinite(seconds) || seconds <= 0) return NO_COOLDOWN;
  return { readyAt: nowMs + Math.ceil(seconds) * 1000 };
}

/** Whole seconds remaining, never negative. */
export function cooldownRemaining(
  state: CooldownState,
  nowMs: number = Date.now(),
): number {
  if (!state || !state.readyAt) return 0;
  const remainingMs = state.readyAt - nowMs;
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}

export function isCoolingDown(
  state: CooldownState,
  nowMs: number = Date.now(),
): boolean {
  return cooldownRemaining(state, nowMs) > 0;
}

/** `m:ss` for a button label — "0:24", "2:05". */
export function cooldownClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.min(Math.ceil(seconds), 99 * 60 + 59);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * Label for a resend control. Keeping the disabled and enabled copy in one
 * function means the accessibility label and the visible label can never
 * disagree about whether the button is armed.
 */
export function resendLabel(idleLabel: string, remainingSeconds: number): string {
  return remainingSeconds > 0
    ? `Resend in ${cooldownClock(remainingSeconds)}`
    : idleLabel;
}
