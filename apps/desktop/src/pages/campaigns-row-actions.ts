/**
 * campaigns-row-actions — pure logic behind the Campaigns list row
 * actions added in the full-surface wiring pass (#10 resend-unopened,
 * #11 clone).
 *
 * Mirrors apps/api/internal/resend_unopened exactly:
 *   - the handler requires a non-empty subject that differs from the
 *     original (case-insensitive, trimmed) — "duplicate_subject" 422;
 *   - sends are floored to MinHoursBetweenSends = 24h after the
 *     original;
 *   - eligibility: resending to non-openers only makes sense for
 *     campaigns that have actually gone out ("sent" / "running" — the
 *     same pair the list's Sent filter and badge treat as sent).
 *
 * Kept free of React/DOM for the node-env vitest suite.
 */

/** Server constant resend_unopened.MinHoursBetweenSends. */
export const MIN_RESEND_HOURS = 24;

/**
 * Only campaigns that have gone out can be resent to non-openers.
 * Matches the page's Sent filter semantics (sent | running).
 */
export function isResendEligible(status: string | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "sent" || s === "running";
}

/**
 * Suggested resend subject. "Re: <original>" always differs from the
 * original under the server's case-insensitive comparison, so the
 * prefill passes validation as-is. No original subject → empty string
 * (operator must type one; the server requires it).
 */
export function defaultResendSubject(original: string | undefined): string {
  const o = (original ?? "").trim();
  return o ? `Re: ${o}` : "";
}

/**
 * Client-side mirror of the resend handler's subject validation.
 * Returns an error message, or null when the subject is acceptable.
 */
export function validateResendSubject(
  subject: string,
  originalSubject: string | undefined,
): string | null {
  const s = subject.trim();
  if (!s) return "A fresh subject line is required for resends.";
  const o = (originalSubject ?? "").trim();
  if (o && s.toLowerCase() === o.toLowerCase()) {
    return "The resend subject must differ from the original.";
  }
  return null;
}
