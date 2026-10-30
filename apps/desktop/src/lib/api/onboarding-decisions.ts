/**
 * Typed client for onboarding DECISIONS — `GET/PUT /api/v1/onboarding/steps`
 * (apps/api/internal/onboarding_progress).
 *
 * WHY THIS EXISTS. `OnboardingStateController` has carried an
 * `OnboardingDecisionPort` since the endpoint shipped, unit-tested against a
 * fake and never once constructed against the real transport. So every
 * dismissal a desktop user made still lived only in this device's
 * localStorage: dismiss the setup checklist here, open the web app, and it was
 * back; dismiss it there, pick up the phone, and it was back again. Mobile
 * already talks to this endpoint. Desktop declared the seam and never crossed
 * it. This module is the crossing.
 *
 * DONE-NESS IS NOT HERE. Whether a step is complete stays a server-side query
 * over real rows (`GET /api/v1/onboarding-progress`, `api.onboardingProgress`)
 * because a stored copy drifts the moment someone deletes the thing that
 * completed it. Only the human decision travels.
 */
import {
  ONBOARDING_DECISION_STATES,
  parseOnboardingStepDecisions,
  type OnboardingDecisionState,
  type OnboardingStepDecisions,
} from "@postwave/onboarding-schema";

import type { ApiRequester, ApiResult } from "./result";

const BASE = "/api/v1/onboarding/steps";

export type { OnboardingDecisionState, OnboardingStepDecisions };

export function createOnboardingDecisionsApi(request: ApiRequester) {
  return {
    /**
     * Every decision this person has recorded, on any device.
     *
     * Normalized through the shared parser rather than cast: an entry whose
     * state this build does not recognize is dropped, and the decisions it
     * does understand still apply. Casting the envelope would let one unknown
     * future state decide what the whole checklist does.
     */
    async list(): Promise<ApiResult<OnboardingStepDecisions>> {
      const res = await request<unknown>(BASE);
      if (res.error) return res;
      return { data: parseOnboardingStepDecisions(res.data) };
    },

    /**
     * Record one decision. Idempotent server-side (upsert), so a retry after a
     * flaky connection is not an error.
     *
     * The state is validated here as well as by the server's closed vocabulary
     * and the CHECK constraint, because a 400 arriving at a fire-and-forget
     * caller is invisible — it would look exactly like a dismissal that
     * silently failed to travel.
     */
    set(
      stepKey: string,
      state: OnboardingDecisionState,
      reason?: string,
    ): Promise<ApiResult<{ ok: boolean }>> {
      if (!(ONBOARDING_DECISION_STATES as readonly string[]).includes(state)) {
        return Promise.resolve({
          error: {
            message: `unsupported onboarding decision state: ${state}`,
            code: "invalid_state",
            kind: "invalid_config",
          },
          retryability: "not-retryable",
        });
      }
      return request<{ ok: boolean }>(BASE, {
        method: "PUT",
        body: JSON.stringify({
          step_key: stepKey,
          state,
          ...(reason ? { reason } : {}),
        }),
      });
    },
  };
}

export type OnboardingDecisionsApi = ReturnType<
  typeof createOnboardingDecisionsApi
>;
