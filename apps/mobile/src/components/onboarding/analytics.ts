/**
 * onboarding/analytics — typed bridge between the shared onboarding event
 * contract (@postwave/onboarding-schema property shapes + @postwave/telemetry
 * canonical names) and the mobile app's existing PostHog wrapper
 * (lib/telemetry `track`).
 *
 * Every onboarding event carries `platform: "mobile"`. Callers pass the
 * matching *Props shape (minus `platform`, which we inject) so names and
 * payloads can't silently diverge from web/desktop. `track` is a cheap
 * no-op until telemetry is initialised AND opted-in, so these are safe to
 * call unconditionally.
 */
import type {
  OnboardingEventProps,
  OnboardingPlatform,
} from "@postwave/onboarding-schema";
import { EVENTS } from "@postwave/telemetry";

import { track } from "@/lib/telemetry";

const PLATFORM: OnboardingPlatform = "mobile";

/**
 * Emit an onboarding event by its canonical name with the matching typed
 * properties (the `platform` field is added here). One generic so the
 * compiler binds name → props from the shared contract.
 */
export function trackOnboarding<N extends keyof OnboardingEventProps>(
  name: N,
  props: Omit<OnboardingEventProps[N], "platform">,
): void {
  track(name, { ...props, platform: PLATFORM });
}

/** Canonical event names, re-exported so callers don't import EVENTS directly. */
export const ONBOARDING_EVENTS = {
  tourStarted: EVENTS.ONBOARDING_TOUR_STARTED,
  tourStepViewed: EVENTS.ONBOARDING_TOUR_STEP_VIEWED,
  tourStepSkipped: EVENTS.ONBOARDING_TOUR_STEP_SKIPPED,
  tourCompleted: EVENTS.ONBOARDING_TOUR_COMPLETED,
  tourDismissed: EVENTS.ONBOARDING_TOUR_DISMISSED,
  checklistViewed: EVENTS.ONBOARDING_CHECKLIST_VIEWED,
  checklistGoalCompleted: EVENTS.ONBOARDING_CHECKLIST_GOAL_COMPLETED,
  checklistCompleted: EVENTS.ONBOARDING_CHECKLIST_COMPLETED,
  wizardStarted: EVENTS.ONBOARDING_WIZARD_STARTED,
  wizardStepCompleted: EVENTS.ONBOARDING_WIZARD_STEP_COMPLETED,
  wizardCompleted: EVENTS.ONBOARDING_WIZARD_COMPLETED,
  milestoneCelebrated: EVENTS.ONBOARDING_MILESTONE_CELEBRATED,
  emptyStateCtaClicked: EVENTS.ONBOARDING_EMPTY_STATE_CTA_CLICKED,
} as const;
