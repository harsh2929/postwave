/**
 * lib/formSubmissions.ts — when a confirmation can usefully be re-sent.
 *
 * The form detail screen has always rendered each submission's status, so a
 * `pending` row is visibly somebody who filled the form and never confirmed.
 * The only recovery is another confirmation email, and until now the screen
 * showed the problem and not the verb.
 */

/**
 * Only a PENDING submission can be re-sent.
 *
 * The server answers 409 for an already-confirmed one, so offering the control
 * everywhere would put a guaranteed refusal beside a real action. Unknown
 * statuses return false rather than being guessed at: a status this build does
 * not recognise came from a newer server, and inventing a meaning for it is how
 * a client offers something the server will reject.
 */
export function canResendConfirmation(submission: {
  status?: string | null | undefined;
}): boolean {
  return (submission.status ?? "").trim().toLowerCase() === "pending";
}

/** What actually happens, in the recipient's terms rather than the system's. */
export const RESEND_CONFIRMATION_CONSEQUENCE =
  "They get another confirmation email. Until they open it they stay unconfirmed and receive nothing else.";
