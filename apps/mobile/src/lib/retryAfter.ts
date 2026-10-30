/**
 * retryAfter — parse an HTTP `Retry-After` header into seconds.
 *
 * `AuthBruteforceLimiter` (apps/api/internal/middleware/auth_bruteforce.go)
 * answers a locked-out credential endpoint with `429` +
 * `Retry-After: 300`, but nothing in the mobile client ever read the header:
 * `authRequest` built its error from the body and status alone. A locked-out
 * user therefore saw no countdown and kept tapping, extending the lockout.
 *
 * RFC 9110 allows BOTH forms — delta-seconds and an HTTP-date — so both are
 * handled here. Everything is clamped and validated because this value drives
 * a disabled primary button: a hostile or broken header must never be able to
 * disable sign-in for a week.
 */

/** Never trust a server header to disable the primary CTA for longer than this. */
export const MAX_RETRY_AFTER_SECONDS = 60 * 60;

/**
 * @param raw   the header value, or null when absent.
 * @param nowMs current time, injectable so the HTTP-date branch is testable.
 * @returns whole seconds in [1, MAX_RETRY_AFTER_SECONDS], or undefined when
 *          the header is missing, malformed, or already in the past.
 */
export function parseRetryAfterSeconds(
  raw: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value || value.length > 64) return undefined;

  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    return Math.min(Math.trunc(seconds), MAX_RETRY_AFTER_SECONDS);
  }

  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  const deltaSeconds = Math.ceil((at - nowMs) / 1000);
  if (deltaSeconds <= 0) return undefined;
  return Math.min(deltaSeconds, MAX_RETRY_AFTER_SECONDS);
}
