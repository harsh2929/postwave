/**
 * lib/campaignResend.ts — the guards on "resend to non-openers".
 *
 * Mobile and desktop drive two genuinely different backend routes for the
 * same idea, and mobile's was the unguarded one:
 *
 *   desktop → POST /api/v1/campaigns/{id}/resend-unopened, which REQUIRES a
 *             subject differing case-insensitively from the original (the
 *             server answers 422 `duplicate_subject` otherwise) and floors
 *             the send at MIN_RESEND_HOURS = 24.
 *   mobile  → POST /api/v1/campaigns/{id}/resend-to-non-openers, whose Go
 *             handler accepts `{subject, send_at}` — and mobile deliberately
 *             sent NEITHER, so the clone inherited the parent's subject and
 *             went out immediately.
 *
 * Re-mailing the same subject line to the same inboxes minutes apart is the
 * exact pattern that gets a sending domain flagged. These helpers port the
 * desktop guards so a resend from a phone is as safe as one from a desk.
 */

/** Minimum delay before a follow-up may go out, matching desktop. */
export const MIN_RESEND_HOURS = 24;
export const RESEND_SUBJECT_MAX = 200;

/**
 * A sensible starting subject: the original prefixed with "Re: ", without
 * stacking a second prefix onto something that already has one.
 */
export function defaultResendSubject(original: string | null | undefined): string {
  const base = (original ?? "").trim();
  if (base.length === 0) return "";
  const prefixed = /^re:\s*/i.test(base) ? base : `Re: ${base}`;
  return prefixed.length > RESEND_SUBJECT_MAX
    ? prefixed.slice(0, RESEND_SUBJECT_MAX)
    : prefixed;
}

/**
 * Validates the follow-up subject the same way the server does. Returns an
 * actionable message, or null when the subject is acceptable.
 */
export function validateResendSubject(
  next: string | null | undefined,
  original: string | null | undefined,
): string | null {
  const value = (next ?? "").trim();
  if (value.length === 0) {
    return "Give the follow-up its own subject line.";
  }
  if (value.length > RESEND_SUBJECT_MAX) {
    return `Subject is too long (${value.length}/${RESEND_SUBJECT_MAX}).`;
  }
  const base = (original ?? "").trim();
  if (base.length > 0 && value.toLowerCase() === base.toLowerCase()) {
    return "Use a different subject from the original — re-sending the same line to the same inboxes gets a domain flagged.";
  }
  return null;
}

/** The earliest instant a follow-up may be scheduled for. */
export function earliestResendAt(now = Date.now()): Date {
  return new Date(now + MIN_RESEND_HOURS * 60 * 60 * 1000);
}

export interface ResendPlan {
  subject: string;
  /** ISO timestamp, or null to let the gateway send as soon as it can. */
  sendAt: string | null;
}

/**
 * Build the request body. A `send_at` earlier than the 24-hour floor is
 * raised to the floor rather than being silently accepted — the point of the
 * delay is that it cannot be skipped by a stale picker.
 */
export function resendPlan(input: {
  subject: string;
  sendAt: Date | null;
  now?: number;
}): ResendPlan {
  const now = input.now ?? Date.now();
  const floor = earliestResendAt(now);
  if (!input.sendAt) return { subject: input.subject.trim(), sendAt: null };
  const at = input.sendAt.getTime();
  const effective =
    !Number.isFinite(at) || at < floor.getTime() ? floor : input.sendAt;
  return { subject: input.subject.trim(), sendAt: effective.toISOString() };
}

/** Human summary of when the follow-up will go out. */
export function resendTimingLabel(sendAt: Date | null): string {
  if (!sendAt) {
    return "Sends as soon as the queue picks it up — not recommended so soon after the original.";
  }
  return `Sends no earlier than ${MIN_RESEND_HOURS} hours after now, which gives the original time to land.`;
}
