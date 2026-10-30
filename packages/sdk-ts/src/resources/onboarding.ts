import { Resource } from "./_base.js";

/**
 * Onboarding DECISIONS — the choices a person made, shared across their devices.
 *
 * Whether a step is DONE stays derived server-side by
 * `GET /api/v1/onboarding-progress`, because a stored copy would drift the
 * moment someone deleted the thing that completed it. This resource carries the
 * other half: what a query cannot recover, because a human decided it.
 *
 * WHY IT EXISTS. Those decisions lived in per-device keys —
 * `postwave_onboarding_checklist_dismissed` and friends in localStorage /
 * AsyncStorage. So a user dismissed the checklist on desktop, opened the web
 * app, and it was back; dismissed it there, picked up their phone, and it was
 * back again. The product asked the same question on every device until it was
 * answered on every device, and the answer was never a device's to hold.
 *
 * Scoped to (tenant, user, step). Per-user rather than per-tenant because these
 * are personal: one admin dismissing a checklist must not hide it from a
 * colleague who has not seen it.
 */

/** What a person decided about a step. */
export type OnboardingStepState =
  | "dismissed"
  | "snoozed"
  | "skipped"
  | "inapplicable"
  | "delegated";

export interface OnboardingStepDecision {
  state: OnboardingStepState;
  /**
   * Free text, meaningful for `skipped`: "we use Salesforce for this". It is
   * why a skip is worth distinguishing from a dismissal — one is "not now", the
   * other is "not us", and only the second should stay gone.
   */
  reason?: string;
}

export interface OnboardingStepDecisions {
  /** step_key → decision. Absent key means no decision recorded. */
  steps: Record<string, OnboardingStepDecision>;
}

/**
 * What the PUT actually returns.
 *
 * This resource used to declare `Promise<OnboardingStepDecision>` for
 * `setStepDecision`, which the handler has never sent — it replies `{"ok":
 * true}`. Nothing broke only because the one caller ignored the value; a caller
 * that trusted the type would have read `undefined` off every field.
 */
export interface OnboardingStepDecisionAck {
  ok: boolean;
}

export class OnboardingResource extends Resource {
  /** Every decision this user has recorded, across all their devices. */
  listStepDecisions(): Promise<OnboardingStepDecisions> {
    return this.client.request("GET", "/api/v1/onboarding/steps");
  }

  /**
   * Record one decision. Idempotent — deciding the same thing twice is not an
   * error, so a client retrying on a flaky connection does not have to care.
   */
  setStepDecision(
    stepKey: string,
    state: OnboardingStepState,
    reason?: string,
  ): Promise<OnboardingStepDecisionAck> {
    return this.client.request("PUT", "/api/v1/onboarding/steps", {
      body: {
        step_key: stepKey,
        state,
        ...(reason ? { reason } : {}),
      },
    });
  }
}
