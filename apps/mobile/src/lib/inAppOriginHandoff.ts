/**
 * lib/inAppOriginHandoff.ts — a one-shot, in-memory vouch that an API origin
 * was chosen by the person holding the phone, in this app, moments ago.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `app/(auth)/device-sign-in.tsx` accepts a `base_url` route param. That screen
 * is reachable by system URL (`moosewave://device-sign-in?base_url=...`), because
 * `+native-intent` hands unrecognised paths straight to Expo Router — so the
 * param is attacker-reachable, and adopting a NEW origin from it let a hostile
 * server take the sign-in flow and, worse, persist itself as the address the
 * password form later pre-fills.
 *
 * The screen therefore only honours an origin the device already knows. That is
 * correct for a returning user, but it broke the legitimate hand-off: on a FIRST
 * self-hosted setup the URL the operator just typed into the sign-in form is, by
 * definition, in no stored source yet, so it was silently dropped and the screen
 * reverted to the vendor default.
 *
 * A route param cannot tell those two cases apart — both are strings. Process
 * memory can: a deep link arrives from outside the app and cannot write here.
 * So the in-app caller deposits the origin it is about to navigate with, and the
 * destination screen redeems it exactly once.
 *
 * Deliberately NOT persisted. Surviving a launch is precisely the property that
 * would let a stale or planted value be redeemed by a link later.
 */

/** The origin an in-app caller is handing to the next screen, if any. */
let pending: string | null = null;

/** Record that THIS app is navigating with `origin`, chosen in-app just now. */
export function depositInAppOrigin(origin: string): void {
  pending = origin.trim() ? origin : null;
}

/**
 * Redeem the deposit if it matches `candidate`. One shot: a redeemed value is
 * cleared, so a later link carrying the same string is not vouched for by it.
 */
export function redeemInAppOrigin(candidate: string): boolean {
  if (!pending) return false;
  const matched = pending === candidate;
  pending = null;
  return matched;
}

/** Test seam, and the sign-out path's way of dropping an unredeemed deposit. */
export function clearInAppOrigin(): void {
  pending = null;
}
