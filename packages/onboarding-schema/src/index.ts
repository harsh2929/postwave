/**
 * @postwave/onboarding-schema — the single source of truth for onboarding
 * CONTENT and CONTRACTS across web, desktop, and mobile.
 *
 * What lives here (pure types + constants, zero runtime deps):
 *  - tour.ts        — the Tour/TourStep content schema + adaptive filtering
 *  - checklist.ts   — the canonical getting-started goals (keys align 1:1 with
 *                     the server's /onboarding-progress step keys)
 *  - progress.ts    — client types for GET /api/v1/onboarding-progress
 *  - decisions.ts   — the closed DECISION vocabulary + step keys for
 *                     GET/PUT /api/v1/onboarding/steps, and what each state
 *                     means for a surface (done-ness is derived; a decision
 *                     is the only onboarding fact a client may write)
 *  - empty-state.ts — outcome-framed empty-state copy
 *  - hint.ts        — inline contextual `?` help content
 *  - analytics.ts   — onboarding event property shapes (names live in
 *                     @postwave/telemetry; bound at the call site)
 *
 * Each platform renders these natively. One definition, three renderers.
 */

export {
  type TourPlacement,
  type TourStep,
  type Tour,
  adaptiveSteps,
  DASHBOARD_TOUR_ID,
  CATALOG_TOUR_ID,
} from "./tour.js";

export {
  type ChecklistGoalKey,
  type ChecklistTier,
  type OnboardingRouteKey,
  type ChecklistGoal,
  CHECKLIST_GOAL_KEYS,
  CHECKLIST_GOALS,
  PATH_TO_SEND_GOALS,
  goalForKey,
} from "./checklist.js";

export {
  type OnboardingStep,
  type OnboardingProgress,
  isOnboardingProgress,
  isGoalComplete,
} from "./progress.js";

export {
  type OnboardingDecisionState,
  type OnboardingDecisionStepKey,
  type OnboardingStepDecision,
  type OnboardingStepDecisions,
  ONBOARDING_DECISION_STATES,
  ONBOARDING_DECISION_STEP_KEYS,
  ONBOARDING_DECISION_RESTORE_STATE,
  CHECKLIST_DECISION_STEP_KEY,
  TOUR_DECISION_STEP_KEY,
  isOnboardingDecisionState,
  decisionHidesSurface,
  parseOnboardingStepDecisions,
  decisionForStep,
  surfaceIsDecidedAway,
} from "./decisions.js";

export {
  type EmptyStateIllustration,
  type EmptyStateCta,
  type EmptyStateContent,
  EMPTY_STATES,
} from "./empty-state.js";

export {
  type ContextualHint,
  CONTEXTUAL_HINTS,
} from "./hint.js";

export {
  type OnboardingPlatform,
  type OnboardingMilestone,
  type OnboardingEventName,
  type OnboardingEventProps,
  type TourStartedProps,
  type TourStepViewedProps,
  type TourStepSkippedProps,
  type TourCompletedProps,
  type TourDismissedProps,
  type ChecklistViewedProps,
  type ChecklistGoalCompletedProps,
  type ChecklistCompletedProps,
  type WizardStepCompletedProps,
  type WizardCompletedProps,
  type MilestoneCelebratedProps,
  type EmptyStateCtaClickedProps,
  type NudgeProps,
  ONBOARDING_EVENT_NAMES,
} from "./analytics.js";
