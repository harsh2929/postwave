// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Onboarding DECISIONS on web — `GET/PUT /api/v1/onboarding/steps`.
 *
 * WHAT WAS MISSING. Web had no decision path at all: no read, no write, and no
 * way to put the getting-started checklist away. Mobile records a dismissal
 * against this endpoint and desktop's state controller has carried a decision
 * port since the endpoint shipped. Web rendered the checklist unconditionally,
 * so a person who dismissed it on their phone opened the web app and it was
 * back — permanently, with no control to dismiss it again. Answering the
 * question on one device did nothing here, and there was nothing here to
 * answer it with.
 *
 * DONE-NESS IS NOT HERE. Whether a step is complete stays a server-side query
 * over real rows (`GET /api/v1/onboarding-progress`), because a stored copy
 * drifts the moment someone deletes the thing that completed it. A client can
 * only record what a person CHOSE — the closed vocabulary in
 * @postwave/onboarding-schema, enforced again by the server and by a CHECK
 * constraint. There is deliberately no way to write "complete" from here.
 */

import {
  ONBOARDING_DECISION_RESTORE_STATE,
  parseOnboardingStepDecisions,
  type OnboardingDecisionState,
  type OnboardingStepDecisions,
} from "@postwave/onboarding-schema";

import { api } from "@/lib/api";

const PATH = "/api/v1/onboarding/steps";

export interface OnboardingRequestOptions {
  signal?: AbortSignal;
  requireOnline?: boolean;
  maxAttempts?: number;
  idempotencyKey?: string;
}

/**
 * Every decision this person has recorded, on any device.
 *
 * Normalized through the shared parser rather than cast, so a state a newer
 * server understands and this build does not cannot blank out the decisions
 * this build does understand.
 */
export async function fetchOnboardingDecisions(
  options: Omit<OnboardingRequestOptions, "idempotencyKey"> = {},
): Promise<OnboardingStepDecisions> {
  return parseOnboardingStepDecisions(await api.get<unknown>(PATH, options));
}

/**
 * Record one decision for this person.
 *
 * The server upserts, so retrying after a flaky connection is not an error.
 * Callers own the failure policy: a preference is not a mutation anyone is
 * waiting on, but this function still rejects rather than swallowing, so a
 * caller that wants to roll back an optimistic update can.
 */
export async function setOnboardingDecision(
  stepKey: string,
  state: OnboardingDecisionState,
  reason?: string,
  options: OnboardingRequestOptions = {},
): Promise<void> {
  await api.put<{ ok: boolean }>(
    PATH,
    {
      step_key: stepKey,
      state,
      ...(reason ? { reason } : {}),
    },
    options,
  );
}

/**
 * Bring a dismissed surface back.
 *
 * There is no "undecided" in the vocabulary, and inventing one would give an
 * absent row a second meaning. `snoozed` is the honest fit — the person wants
 * to see it again now — and it is the same state mobile writes for its
 * "Show setup checklist" control, so the two undo paths agree.
 */
export async function restoreOnboardingSurface(
  stepKey: string,
  options: OnboardingRequestOptions = {},
): Promise<void> {
  await setOnboardingDecision(
    stepKey,
    ONBOARDING_DECISION_RESTORE_STATE,
    undefined,
    options,
  );
}
