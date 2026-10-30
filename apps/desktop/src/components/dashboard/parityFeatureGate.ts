/**
 * parityFeatureGate — hide-vs-error gating for MailchimpParityCard.
 * Split out of the .tsx so the node-environment vitest suite can
 * import it (the desktop tsconfig keeps `jsx: preserve`, so .tsx
 * modules can't be imported by tests directly).
 */

/** Statuses meaning "this surface isn't shipped on this deployment" —
 *  the card hides entirely instead of rendering an error (or, worse,
 *  a fake all-zero snapshot). Only 404/501 qualify: the parity reads
 *  accept session auth now, so a 401/403 is a genuine authorization
 *  failure and flows through the card's normal error path. */
export function isFeatureAbsent(status?: number): boolean {
  return status === 404 || status === 501;
}
