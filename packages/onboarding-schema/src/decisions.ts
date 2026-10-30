/**
 * Onboarding DECISIONS — the half of onboarding state a query cannot recover.
 *
 * `GET /api/v1/onboarding-progress` derives every step's done-ness from
 * EXISTS probes over real tables, so done-ness is already shared and already
 * honest: a client cannot self-mark a step complete, and a stored copy would
 * drift the moment someone deleted the thing that completed it.
 *
 * What is NOT derivable is anything a human decided — "dismissed", "snoozed",
 * "not applicable to us", "someone else is doing this". Those lived in
 * per-device keys (`postwave_onboarding_checklist_dismissed` and friends in
 * localStorage / AsyncStorage), so a user dismissed the checklist on desktop,
 * opened the web app, and it was back; dismissed it there, picked up their
 * phone, and it was back again. The product asked one question on every device
 * until it was answered on every device, and the answer was never a device's
 * to hold.
 *
 * `GET/PUT /api/v1/onboarding/steps` is the durable per-(tenant, user, step)
 * home for those decisions. This module is the CLIENT half of that contract:
 * the vocabulary, the step keys, the wire types, and — the part that actually
 * decides what a user sees — what each state MEANS for a surface.
 *
 * WHY IT LIVES HERE. Before this file, web had no decision path at all, and
 * desktop and mobile each carried a private copy of the string
 * `"dashboard_checklist"` and a private, DIFFERENT opinion about which states
 * hide a surface. Two copies of one fact is how a shared decision quietly
 * becomes three unshared ones again; the server's CHECK constraint cannot
 * catch a client that simply ignores three of the five states.
 */

/**
 * The CLOSED write vocabulary, mirroring `validStepStates` in
 * apps/api/internal/onboarding_progress/onboarding_progress.go and the CHECK
 * constraint in infra/migrations/1870_onboarding_step_state.sql. All three
 * must change in lockstep; a test asserts exactly that.
 */
export const ONBOARDING_DECISION_STATES = [
  "dismissed",
  "snoozed",
  "skipped",
  "inapplicable",
  "delegated",
] as const;

/** What a person decided about one onboarding step. */
export type OnboardingDecisionState =
  (typeof ONBOARDING_DECISION_STATES)[number];

/**
 * The step key the getting-started checklist's dismissal is recorded under.
 *
 * Not a `ChecklistGoalKey`: those name tenant SETUP WORK whose done-ness the
 * server derives. This names a SURFACE a person chose to put away. Keeping the
 * two namespaces distinct is what stops a client ever writing a decision that
 * looks like it marked a setup step complete.
 */
export const CHECKLIST_DECISION_STEP_KEY = "dashboard_checklist";

/**
 * The step key the dashboard tour's dismissal is recorded under.
 *
 * Same shape as the checklist above and the same reason: it names a SURFACE a
 * person put away, not setup work whose done-ness the server derives.
 *
 * It exists because the tour was the last per-device answer left. All three
 * clients kept `postwave_tour_dashboard_dismissed_at` in their own local
 * storage, so someone dismissed the tour on the laptop, opened the phone, and
 * the tour ran again — the product asking a question that had already been
 * answered, on every device separately, which is exactly what migration 1870's
 * header names as in scope.
 *
 * No migration was needed for this: `onboarding_step_state` constrains `state`
 * to the closed five-value vocabulary and deliberately does NOT constrain
 * `step_key`, so the key space is the clients' to extend and this list is what
 * keeps it closed.
 */
export const TOUR_DECISION_STEP_KEY = "dashboard_tour";

/** Every decision step key a client may write. Closed for the same reason. */
export const ONBOARDING_DECISION_STEP_KEYS = [
  CHECKLIST_DECISION_STEP_KEY,
  TOUR_DECISION_STEP_KEY,
] as const;

export type OnboardingDecisionStepKey =
  (typeof ONBOARDING_DECISION_STEP_KEYS)[number];

/** One decision, as `GET /api/v1/onboarding/steps` returns it. */
export interface OnboardingStepDecision {
  state: OnboardingDecisionState;
  /**
   * Free text, meaningful for `skipped`: "we use Salesforce for this". It is
   * why a skip is worth distinguishing from a dismissal — one is "not now",
   * the other is "not us", and only the second should stay gone.
   */
  reason?: string;
}

/** The `GET /api/v1/onboarding/steps` envelope. */
export interface OnboardingStepDecisions {
  /** step_key → decision. An absent key means no decision was recorded. */
  steps: Record<string, OnboardingStepDecision>;
}

/**
 * States that mean "stop showing me this".
 *
 * `snoozed` is deliberately absent, and is also what a client writes to UNDO a
 * dismissal: there is no "undecided" in the vocabulary, and inventing one
 * would give an absent row a second meaning. "Show it to me again now" is an
 * honest reading of snoozed and needs no new state.
 */
const HIDING_STATES: ReadonlySet<string> = new Set<OnboardingDecisionState>([
  "dismissed",
  "skipped",
  "inapplicable",
  "delegated",
]);

/** The state a client writes to bring a dismissed surface back. */
export const ONBOARDING_DECISION_RESTORE_STATE: OnboardingDecisionState =
  "snoozed";

export function isOnboardingDecisionState(
  value: unknown,
): value is OnboardingDecisionState {
  return (
    typeof value === "string" &&
    (ONBOARDING_DECISION_STATES as readonly string[]).includes(value)
  );
}

/**
 * Does this decision mean the surface stays hidden?
 *
 * Unknown states read as "not hiding". A newer server could add a sixth state
 * whose meaning this client cannot know, and guessing "hide" would make a
 * surface vanish for a reason nobody here understands. Failing toward SHOWING
 * is recoverable — the user dismisses it again — while failing toward hiding
 * silently removes the only route back.
 */
export function decisionHidesSurface(state: string | undefined | null): boolean {
  return typeof state === "string" && HIDING_STATES.has(state);
}

/**
 * Normalize a raw `GET /api/v1/onboarding/steps` payload.
 *
 * Returns an empty decision set rather than throwing, and drops individual
 * entries that are not part of the closed vocabulary. Total rejection of the
 * whole envelope over one unrecognized entry would throw away the decisions
 * the client DOES understand, which is the "silently empty screen" failure
 * this codebase has hit before when a response shape drifted.
 */
export function parseOnboardingStepDecisions(
  value: unknown,
): OnboardingStepDecisions {
  const empty: OnboardingStepDecisions = { steps: {} };
  if (typeof value !== "object" || value === null) return empty;
  const raw = (value as { steps?: unknown }).steps;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return empty;
  }
  const steps: Record<string, OnboardingStepDecision> = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const state = (entry as { state?: unknown }).state;
    if (!isOnboardingDecisionState(state)) continue;
    const reason = (entry as { reason?: unknown }).reason;
    steps[key] =
      typeof reason === "string" && reason !== ""
        ? { state, reason }
        : { state };
  }
  return { steps };
}

/** The decision recorded for one step, or null when the person made none. */
export function decisionForStep(
  decisions: OnboardingStepDecisions | null | undefined,
  stepKey: string,
): OnboardingStepDecision | null {
  return decisions?.steps?.[stepKey] ?? null;
}

/**
 * Has this person put this surface away — on ANY of their devices?
 *
 * The one question every renderer asks, answered the same way on all three so
 * a decision taken on a phone is honoured on a laptop without each client
 * re-deriving "which states count".
 */
export function surfaceIsDecidedAway(
  decisions: OnboardingStepDecisions | null | undefined,
  stepKey: string,
): boolean {
  return decisionHidesSurface(decisionForStep(decisions, stepKey)?.state);
}
