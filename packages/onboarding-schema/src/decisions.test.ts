import { describe, expect, it } from "vitest";

import {
  CHECKLIST_DECISION_STEP_KEY,
  CHECKLIST_GOAL_KEYS,
  ONBOARDING_DECISION_RESTORE_STATE,
  ONBOARDING_DECISION_STATES,
  ONBOARDING_DECISION_STEP_KEYS,
  decisionForStep,
  decisionHidesSurface,
  isOnboardingDecisionState,
  parseOnboardingStepDecisions,
  surfaceIsDecidedAway,
} from "./index";

/**
 * The exact vocabulary the server accepts — `validStepStates` in
 * apps/api/internal/onboarding_progress/onboarding_progress.go, enforced again
 * by the CHECK constraint in infra/migrations/1870_onboarding_step_state.sql.
 * If the server widens or narrows it, THIS list must change in lockstep; a
 * repo-level test (apps/web/src/__tests__/onboarding-decision-vocabulary.test.ts)
 * reads both server sources and fails if they drift from this package.
 */
const SERVER_DECISION_STATES = [
  "dismissed",
  "snoozed",
  "skipped",
  "inapplicable",
  "delegated",
];

describe("decision vocabulary", () => {
  it("matches the server's closed write vocabulary exactly", () => {
    expect([...ONBOARDING_DECISION_STATES].sort()).toEqual(
      [...SERVER_DECISION_STATES].sort(),
    );
  });

  it("rejects a state the server would reject", () => {
    // A client inventing "hidden" or "done" is how one shared fact becomes
    // three again — and "done" in particular must never be writable, because
    // done-ness is derived from real rows and a client cannot self-mark it.
    expect(isOnboardingDecisionState("dismissed")).toBe(true);
    expect(isOnboardingDecisionState("done")).toBe(false);
    expect(isOnboardingDecisionState("hidden")).toBe(false);
    expect(isOnboardingDecisionState(undefined)).toBe(false);
  });

  it("keeps decision step keys out of the derived-goal namespace", () => {
    // A decision key naming a setup goal would let a dismissal read as
    // progress. The two namespaces must not overlap.
    for (const key of ONBOARDING_DECISION_STEP_KEYS) {
      expect(CHECKLIST_GOAL_KEYS as readonly string[]).not.toContain(key);
    }
  });
});

describe("what a state means for a surface", () => {
  it("hides on every 'stop showing me this' state", () => {
    expect(decisionHidesSurface("dismissed")).toBe(true);
    expect(decisionHidesSurface("skipped")).toBe(true);
    // "not us" and "someone else is doing this" are the two states that must
    // stay gone; a client that honoured only `dismissed` re-asked an
    // impossible step forever.
    expect(decisionHidesSurface("inapplicable")).toBe(true);
    expect(decisionHidesSurface("delegated")).toBe(true);
  });

  it("does not hide on snooze — which is also the undo", () => {
    expect(decisionHidesSurface(ONBOARDING_DECISION_RESTORE_STATE)).toBe(false);
    expect(decisionHidesSurface("snoozed")).toBe(false);
  });

  it("shows, not hides, on a state this client does not know", () => {
    // Guessing "hide" for an unrecognized future state would make a surface
    // vanish with no route back. Failing toward SHOWING is recoverable.
    expect(decisionHidesSurface("quarantined")).toBe(false);
    expect(decisionHidesSurface(null)).toBe(false);
  });
});

describe("parsing the wire payload", () => {
  it("reads the server envelope", () => {
    const parsed = parseOnboardingStepDecisions({
      steps: {
        [CHECKLIST_DECISION_STEP_KEY]: {
          state: "skipped",
          reason: "we use Salesforce for this",
        },
      },
    });
    expect(decisionForStep(parsed, CHECKLIST_DECISION_STEP_KEY)).toEqual({
      state: "skipped",
      reason: "we use Salesforce for this",
    });
    expect(surfaceIsDecidedAway(parsed, CHECKLIST_DECISION_STEP_KEY)).toBe(true);
  });

  it("keeps the decisions it understands when one entry is junk", () => {
    // Rejecting the whole envelope over one unrecognized entry throws away
    // decisions the client DOES understand — the silently-empty-screen bug.
    const parsed = parseOnboardingStepDecisions({
      steps: {
        [CHECKLIST_DECISION_STEP_KEY]: { state: "dismissed" },
        some_future_surface: { state: "quarantined" },
        malformed: null,
      },
    });
    expect(surfaceIsDecidedAway(parsed, CHECKLIST_DECISION_STEP_KEY)).toBe(true);
    expect(decisionForStep(parsed, "some_future_surface")).toBeNull();
    expect(decisionForStep(parsed, "malformed")).toBeNull();
  });

  it("survives junk without throwing", () => {
    for (const junk of [null, undefined, 42, "steps", { steps: [] }, {}]) {
      expect(parseOnboardingStepDecisions(junk)).toEqual({ steps: {} });
    }
  });

  it("treats an absent decision as no decision", () => {
    expect(surfaceIsDecidedAway({ steps: {} }, CHECKLIST_DECISION_STEP_KEY)).toBe(
      false,
    );
    expect(surfaceIsDecidedAway(null, CHECKLIST_DECISION_STEP_KEY)).toBe(false);
  });
});
