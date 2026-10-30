/**
 * Telemetry consent — one default + one decision helper for every client.
 *
 * The audit found consent defaulted opt-IN on web but opt-OUT on
 * desktop/mobile, and the authenticated web dashboard captured with no
 * consent surface — a GDPR liability. This makes the default uniform
 * (opt-OUT until the user affirmatively consents) and gives every client
 * the same gate.
 */

export type ConsentState = "granted" | "denied" | "unset";

/** Capture is OFF until the user affirmatively opts in. */
export const TELEMETRY_CONSENT_DEFAULT: ConsentState = "denied";

/**
 * Whether analytics/telemetry may be captured. Only an explicit `granted`
 * enables capture; `unset` is treated as denied (opt-IN model, not opt-OUT).
 */
export function shouldCapture(consent: ConsentState | null | undefined): boolean {
  return consent === "granted";
}
