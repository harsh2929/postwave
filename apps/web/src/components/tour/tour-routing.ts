import {
  TOUR_DECISION_STEP_KEY,
  decisionHidesSurface,
} from "@postwave/onboarding-schema";

export function shouldAutoStartTour(
  pathname: string,
  startsOn: string | undefined,
): boolean {
  return Boolean(startsOn) && pathname === startsOn;
}

export function tourNeedsAuthenticatedProgress(tourId: string): boolean {
  return tourId === "dashboard";
}

/**
 * The step key this tour's dismissal is recorded under, or null when the tour
 * records no decision at all.
 *
 * Only the DASHBOARD tour has a person to record for. The marketing tour is
 * served to signed-out visitors: there is no `(tenant, user)` to key a row by,
 * and no request it could authenticate. Its local key therefore stays its only
 * answer — which the gate below still honours rather than treating "nothing
 * recorded" as "never asked".
 */
export function tourDecisionStepKey(tourId: string): string | null {
  return tourId === "dashboard" ? TOUR_DECISION_STEP_KEY : null;
}

/**
 * May this tour launch itself right now?
 *
 * - `allowed`  — nobody has put it away.
 * - `blocked`  — they already answered: dismissed/skipped/inapplicable/delegated.
 * - `unknown`  — the decision has not arrived yet (loading, failed, or nobody
 *                is signed in).
 *
 * THE ORDER OF AUTHORITY, which is the whole design:
 *
 *   1. A recorded decision — in ANY state — WINS, including over this device's
 *      local key. Local storage is a cache, not the authority: if the person
 *      hit "Restart tour" on their phone (which records `snoozed`), this laptop
 *      must show it again even though it remembers them dismissing it here.
 *   2. With NO recorded decision, this device's local key is the only answer
 *      that exists, and it still counts. That is the person who dismissed the
 *      tour before this shipped — deleting their answer would re-ask them
 *      everywhere. It also covers someone whose write the server refuses (a
 *      viewer), so a dismissal that cannot be uploaded still holds here.
 *   3. Until the decision arrives, WAIT.
 *
 * Waiting is the no-flash rule. A tour that runs for a beat and then vanishes
 * when the decision lands is worse than the bug being fixed, and guessing
 * "launch" re-asks a question that may already be answered. The cost is the
 * opposite error: a genuinely new person on a broken connection is not ambushed
 * by a tour, and can still start it from the help menu. That failure is
 * recoverable in one click; interrupting someone who already said no is not
 * recoverable at all.
 *
 * `unknown` is deliberately NOT sticky — a later successful refetch flips it, so
 * a transient 500 delays the tour instead of cancelling it forever.
 */
export type TourAutoStartGate = "allowed" | "blocked" | "unknown";

export function tourAutoStartGate(input: {
  /** Does this tour record a cross-device decision at all? */
  recordsDecision: boolean;
  /** Has `GET /api/v1/onboarding/steps` answered? */
  decisionLoaded: boolean;
  /** The state recorded for this tour, or null when the person never decided. */
  recordedState: string | null;
  /** Has this browser already seen the tour through? */
  dismissedOnThisDevice: boolean;
}): TourAutoStartGate {
  // A tour with nobody to record for (the signed-out marketing tour) has only
  // ever had the local key, and must keep honouring it.
  if (!input.recordsDecision) {
    return input.dismissedOnThisDevice ? "blocked" : "allowed";
  }
  if (!input.decisionLoaded) return "unknown";
  if (input.recordedState !== null) {
    // `decisionHidesSurface` rather than a local list of states: a client that
    // understood only "dismissed" would keep showing a tour the person already
    // called impossible for them, and three clients each with their own list is
    // how one shared decision quietly becomes three unshared ones.
    return decisionHidesSurface(input.recordedState) ? "blocked" : "allowed";
  }
  return input.dismissedOnThisDevice ? "blocked" : "allowed";
}

export function clampTourStartIndex(
  requestedIndex: number,
  stepCount: number,
): number | null {
  if (stepCount <= 0) return null;
  const finiteIndex = Number.isFinite(requestedIndex) ? requestedIndex : 0;
  return Math.max(0, Math.min(Math.trunc(finiteIndex), stepCount - 1));
}
