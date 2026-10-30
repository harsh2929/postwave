/**
 * Onboarding analytics PROPERTY shapes.
 *
 * Separation of concerns: @postwave/telemetry owns the canonical event NAMES
 * (`EVENTS.ONBOARDING_*` → "onboarding.tour_started", …); this module owns the
 * PROPERTY shapes for those events. The two bind at each app's call site,
 * typed by both — so neither package depends on the other, yet names and
 * payloads can't silently diverge across web/desktop/mobile.
 *
 * The string literals below intentionally match @postwave/telemetry's EVENTS
 * values. That is enforced by
 * apps/web/src/__tests__/onboarding-event-name-parity.test.ts, which is the one
 * place able to import BOTH packages — neither can import the other without
 * undoing the independence described above.
 *
 * This used to claim the parity was already guarded "in that package's
 * consumers (and onboarding-schema's own test)". It was not. This module's own
 * test compares the list against ITSELF — no duplicates, dot-namespaced,
 * matching the type's keys — which cannot notice a rename on the telemetry
 * side, and the consumer test it alluded to covers decision STATES rather than
 * event names. The two lists happened to agree; nothing was checking.
 */

/** Which client emitted the event — every onboarding event carries this. */
export type OnboardingPlatform = "web" | "desktop" | "mobile";

interface BaseProps {
  platform: OnboardingPlatform;
}

export interface TourStartedProps extends BaseProps {
  tourId: string;
  /** Number of steps after adaptive filtering. */
  stepCount: number;
  /** "auto" (first-run) vs "manual" (replay/launcher). */
  trigger: "auto" | "manual";
}

export interface TourStepViewedProps extends BaseProps {
  tourId: string;
  stepId: string;
  index: number;
  /** Time the user spent on the previous step before advancing (ms). */
  msOnPrevStep?: number;
}

export interface TourStepSkippedProps extends BaseProps {
  tourId: string;
  stepId: string;
  index: number;
}

export interface TourCompletedProps extends BaseProps {
  tourId: string;
  /** Total wall-clock from start to finish (ms). */
  totalMs: number;
}

export interface TourDismissedProps extends BaseProps {
  tourId: string;
  /** The step the user bailed on. */
  lastStepId: string;
  index: number;
}

export interface ChecklistViewedProps extends BaseProps {
  completed: number;
  total: number;
}

export interface ChecklistGoalCompletedProps extends BaseProps {
  key: string;
}

export interface ChecklistCompletedProps extends BaseProps {
  total: number;
}

export interface WizardStepCompletedProps extends BaseProps {
  wizardId: string;
  stepId: string;
}

export interface WizardCompletedProps extends BaseProps {
  wizardId: string;
}

/** Real product achievement worth celebrating (first import, first send, …). */
export type OnboardingMilestone =
  | "first_subscriber"
  | "first_import"
  | "first_campaign_designed"
  | "first_campaign_sent"
  | "domain_verified"
  | "onboarding_complete";

export interface MilestoneCelebratedProps extends BaseProps {
  milestone: OnboardingMilestone;
}

export interface EmptyStateCtaClickedProps extends BaseProps {
  surfaceId: string;
  cta: "primary" | "secondary";
}

export interface NudgeProps extends BaseProps {
  /** Days the tenant was idle before the nudge fired. */
  idleDays: number;
}

/**
 * The full onboarding event → properties map. Use as the typed contract when
 * wiring each platform's `capture(EVENTS.ONBOARDING_*, props)` call.
 */
export interface OnboardingEventProps {
  "onboarding.tour_started": TourStartedProps;
  "onboarding.tour_step_viewed": TourStepViewedProps;
  "onboarding.tour_step_skipped": TourStepSkippedProps;
  "onboarding.tour_completed": TourCompletedProps;
  "onboarding.tour_dismissed": TourDismissedProps;
  "onboarding.checklist_viewed": ChecklistViewedProps;
  "onboarding.checklist_goal_completed": ChecklistGoalCompletedProps;
  "onboarding.checklist_completed": ChecklistCompletedProps;
  "onboarding.wizard_started": WizardStepCompletedProps;
  "onboarding.wizard_step_completed": WizardStepCompletedProps;
  "onboarding.wizard_completed": WizardCompletedProps;
  "onboarding.milestone_celebrated": MilestoneCelebratedProps;
  "onboarding.empty_state_cta_clicked": EmptyStateCtaClickedProps;
  "onboarding.nudge_shown": NudgeProps;
  "onboarding.nudge_accepted": NudgeProps;
}

/** The onboarding event names, as a runtime-checkable list (mirrors EVENTS). */
export const ONBOARDING_EVENT_NAMES = [
  "onboarding.tour_started",
  "onboarding.tour_step_viewed",
  "onboarding.tour_step_skipped",
  "onboarding.tour_completed",
  "onboarding.tour_dismissed",
  "onboarding.checklist_viewed",
  "onboarding.checklist_goal_completed",
  "onboarding.checklist_completed",
  "onboarding.wizard_started",
  "onboarding.wizard_step_completed",
  "onboarding.wizard_completed",
  "onboarding.milestone_celebrated",
  "onboarding.empty_state_cta_clicked",
  "onboarding.nudge_shown",
  "onboarding.nudge_accepted",
] as const;

export type OnboardingEventName = (typeof ONBOARDING_EVENT_NAMES)[number];
