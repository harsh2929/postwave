import type { OnboardingEventProps } from "@postwave/onboarding-schema";
import {
  CATALOG_TOUR_ID,
  DASHBOARD_TOUR_ID,
} from "@postwave/onboarding-schema";

import {
  CHECKLIST_STEPS,
  isKnownOnboardingStep,
  isOnboardingSurfaceApplicable,
  ONBOARDING_SURFACE_IDS,
  ONBOARDING_SURFACES,
  onboardingStepsForRole,
  type ChecklistStepId,
  type OnboardingStepId,
  type OnboardingSurfaceId,
} from "./onboarding-manifest";
import type { Role } from "./store";

export const ONBOARDING_STATE_VERSION = 3 as const;

export type OnboardingOutcome =
  | "not-started"
  | "in-progress"
  | "completed"
  | "skipped"
  | "dismissed";

export interface OnboardingSurfaceState {
  outcome: OnboardingOutcome;
  currentStepId: OnboardingStepId | null;
  completedStepIds: OnboardingStepId[];
  skippedStepIds: OnboardingStepId[];
  run: number;
  openedAt: number | null;
  updatedAt: number;
}

export interface OnboardingGoalState {
  completedStepIds: ChecklistStepId[];
  fetchedAt: number | null;
  updatedAt: number;
}

export interface OnboardingState {
  version: typeof ONBOARDING_STATE_VERSION;
  scopeToken: string;
  revision: number;
  updatedAt: number;
  surfaces: Record<OnboardingSurfaceId, OnboardingSurfaceState>;
  goals: OnboardingGoalState;
}

export type OnboardingAnalyticsIntent = {
  [Name in keyof OnboardingEventProps]: {
    name: Name;
    props: Omit<OnboardingEventProps[Name], "platform">;
  };
}[keyof OnboardingEventProps];

export type OnboardingTrigger = "auto" | "manual";

export type OnboardingAction =
  | {
      type: "open";
      surface: OnboardingSurfaceId;
      trigger: OnboardingTrigger;
      stepId?: OnboardingStepId;
      stepCount?: number;
      stepIndex?: number;
      now: number;
    }
  | {
      type: "complete-step";
      surface: OnboardingSurfaceId;
      stepId: OnboardingStepId;
      nextStepId?: OnboardingStepId;
      nextStepIndex?: number;
      stepCount?: number;
      msOnStep?: number;
      now: number;
    }
  | {
      type: "skip-step";
      surface: OnboardingSurfaceId;
      stepId: OnboardingStepId;
      nextStepId?: OnboardingStepId;
      nextStepIndex?: number;
      stepCount?: number;
      msOnStep?: number;
      now: number;
    }
  | {
      type: "set-step";
      surface: OnboardingSurfaceId;
      stepId: OnboardingStepId;
      stepIndex?: number;
      msOnPrevStep?: number;
      now: number;
    }
  | {
      type: "complete-surface";
      surface: OnboardingSurfaceId;
      totalMs?: number;
      now: number;
    }
  | {
      type: "skip-surface" | "dismiss-surface";
      surface: OnboardingSurfaceId;
      stepId?: OnboardingStepId;
      stepIndex?: number;
      now: number;
    }
  | {
      type: "reset-surface";
      surface: OnboardingSurfaceId;
      now: number;
    }
  | { type: "reset-all"; now: number }
  | {
      type: "sync-goals";
      completedStepIds: readonly ChecklistStepId[];
      fetchedAt: number;
      announceChanges: boolean;
      now: number;
    };

export interface OnboardingTransition {
  state: OnboardingState;
  intents: OnboardingAnalyticsIntent[];
  changed: boolean;
}

function emptySurfaceState(): OnboardingSurfaceState {
  return {
    outcome: "not-started",
    currentStepId: null,
    completedStepIds: [],
    skippedStepIds: [],
    run: 0,
    openedAt: null,
    updatedAt: 0,
  };
}

export function createOnboardingState(scopeToken: string): OnboardingState {
  return {
    version: ONBOARDING_STATE_VERSION,
    scopeToken,
    revision: 0,
    updatedAt: 0,
    surfaces: {
      wizard: emptySurfaceState(),
      checklist: emptySurfaceState(),
      tour: emptySurfaceState(),
      catalog: emptySurfaceState(),
    },
    goals: { completedStepIds: [], fetchedAt: null, updatedAt: 0 },
  };
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function surfaceWith(
  state: OnboardingState,
  surface: OnboardingSurfaceId,
  next: OnboardingSurfaceState,
  now: number,
): OnboardingState {
  return {
    ...state,
    revision: state.revision + 1,
    updatedAt: now,
    surfaces: { ...state.surfaces, [surface]: next },
  };
}

function stepViewedIntent(options: {
  surface: OnboardingSurfaceId;
  stepId: OnboardingStepId;
  index: number;
  msOnPrevStep?: number;
}): OnboardingAnalyticsIntent[] {
  if (options.surface !== "tour") return [];
  return [
    {
      name: "onboarding.tour_step_viewed",
      props: {
        tourId: DASHBOARD_TOUR_ID,
        stepId: options.stepId,
        index: options.index,
        ...(options.msOnPrevStep != null
          ? { msOnPrevStep: Math.max(0, Math.round(options.msOnPrevStep)) }
          : {}),
      },
    },
  ];
}

function openSurface(
  state: OnboardingState,
  action: Extract<OnboardingAction, { type: "open" }>,
): OnboardingTransition {
  const previous = state.surfaces[action.surface];
  const steps = ONBOARDING_SURFACES[action.surface].steps;
  const requested = action.stepId ?? previous.currentStepId ?? steps[0]?.id;
  if (!requested || !isKnownOnboardingStep(action.surface, requested)) {
    return { state, intents: [], changed: false };
  }
  if (
    previous.outcome === "in-progress" &&
    previous.currentStepId === requested
  ) {
    return { state, intents: [], changed: false };
  }
  if (action.trigger === "auto" && isTerminalOutcome(previous.outcome)) {
    return { state, intents: [], changed: false };
  }
  const next = {
    ...(isTerminalOutcome(previous.outcome) ? emptySurfaceState() : previous),
    outcome: "in-progress" as const,
    currentStepId: requested,
    run: previous.run + 1,
    openedAt: action.now,
    updatedAt: action.now,
  };
  const intents: OnboardingAnalyticsIntent[] = [];
  if (action.surface === "wizard") {
    intents.push({
      name: "onboarding.wizard_started",
      props: { wizardId: "first-run", stepId: requested },
    });
  } else if (action.surface === "tour" || action.surface === "catalog") {
    intents.push({
      name: "onboarding.tour_started",
      props: {
        tourId: action.surface === "tour" ? DASHBOARD_TOUR_ID : CATALOG_TOUR_ID,
        stepCount: action.stepCount ?? steps.length,
        trigger: action.trigger,
      },
    });
    if (action.surface === "tour") {
      intents.push(
        ...stepViewedIntent({
          surface: "tour",
          stepId: requested,
          index: action.stepIndex ?? 0,
        }),
      );
    }
  } else if (action.surface === "checklist") {
    intents.push({
      name: "onboarding.checklist_viewed",
      props: {
        completed: state.goals.completedStepIds.length,
        total: CHECKLIST_STEPS.length,
      },
    });
  }
  return {
    state: surfaceWith(state, action.surface, next, action.now),
    intents,
    changed: true,
  };
}

function changeStep(
  state: OnboardingState,
  action: Extract<OnboardingAction, { type: "set-step" }>,
): OnboardingTransition {
  const previous = state.surfaces[action.surface];
  if (
    previous.outcome !== "in-progress" ||
    previous.currentStepId === action.stepId ||
    !isKnownOnboardingStep(action.surface, action.stepId)
  ) {
    return { state, intents: [], changed: false };
  }
  const next = {
    ...previous,
    currentStepId: action.stepId,
    updatedAt: action.now,
  };
  return {
    state: surfaceWith(state, action.surface, next, action.now),
    intents: stepViewedIntent({
      surface: action.surface,
      stepId: action.stepId,
      index: action.stepIndex ?? 0,
      msOnPrevStep: action.msOnPrevStep,
    }),
    changed: true,
  };
}

function resolveStep(
  state: OnboardingState,
  action: Extract<
    OnboardingAction,
    { type: "complete-step" | "skip-step" }
  >,
): OnboardingTransition {
  const previous = state.surfaces[action.surface];
  if (
    previous.outcome !== "in-progress" ||
    !isKnownOnboardingStep(action.surface, action.stepId)
  ) {
    return { state, intents: [], changed: false };
  }
  const completed = action.type === "complete-step";
  const nextCompleted = completed
    ? unique([...previous.completedStepIds, action.stepId])
    : previous.completedStepIds;
  const nextSkipped = completed
    ? previous.skippedStepIds.filter((id) => id !== action.stepId)
    : unique([...previous.skippedStepIds, action.stepId]);
  const nextStep =
    action.nextStepId &&
    isKnownOnboardingStep(action.surface, action.nextStepId)
      ? action.nextStepId
      : previous.currentStepId;
  const next = {
    ...previous,
    currentStepId: nextStep,
    completedStepIds: nextCompleted,
    skippedStepIds: nextSkipped,
    updatedAt: action.now,
  };
  const intents: OnboardingAnalyticsIntent[] = [];
  if (completed && action.surface === "wizard") {
    intents.push({
      name: "onboarding.wizard_step_completed",
      props: { wizardId: "first-run", stepId: action.stepId },
    });
  }
  if (!completed && action.surface === "tour") {
    intents.push({
      name: "onboarding.tour_step_skipped",
      props: {
        tourId: DASHBOARD_TOUR_ID,
        stepId: action.stepId,
        index: Math.max(0, action.nextStepIndex != null ? action.nextStepIndex - 1 : 0),
      },
    });
  }
  if (nextStep && nextStep !== previous.currentStepId) {
    intents.push(
      ...stepViewedIntent({
        surface: action.surface,
        stepId: nextStep,
        index: action.nextStepIndex ?? 0,
        msOnPrevStep: action.msOnStep,
      }),
    );
  }
  return {
    state: surfaceWith(state, action.surface, next, action.now),
    intents,
    changed: true,
  };
}

function finishSurface(
  state: OnboardingState,
  action: Extract<
    OnboardingAction,
    { type: "complete-surface" | "skip-surface" | "dismiss-surface" }
  >,
): OnboardingTransition {
  const previous = state.surfaces[action.surface];
  const outcome: OnboardingOutcome =
    action.type === "complete-surface"
      ? "completed"
      : action.type === "skip-surface"
        ? "skipped"
        : "dismissed";
  if (previous.outcome === outcome) {
    return { state, intents: [], changed: false };
  }
  const next = {
    ...previous,
    outcome,
    currentStepId: null,
    updatedAt: action.now,
  };
  const intents: OnboardingAnalyticsIntent[] = [];
  if (action.type === "complete-surface" && action.surface === "wizard") {
    intents.push({
      name: "onboarding.wizard_completed",
      props: { wizardId: "first-run" },
    });
  } else if (
    action.type === "complete-surface" &&
    (action.surface === "tour" || action.surface === "catalog")
  ) {
    intents.push({
      name: "onboarding.tour_completed",
      props: {
        tourId: action.surface === "tour" ? DASHBOARD_TOUR_ID : CATALOG_TOUR_ID,
        totalMs: Math.max(
          0,
          Math.round(
            action.totalMs ??
              (previous.openedAt == null ? 0 : action.now - previous.openedAt),
          ),
        ),
      },
    });
  } else if (
    (action.surface === "tour" || action.surface === "catalog") &&
    action.type !== "complete-surface"
  ) {
    const stepId = action.stepId ?? previous.currentStepId ?? "welcome";
    intents.push({
      name: "onboarding.tour_dismissed",
      props: {
        tourId: action.surface === "tour" ? DASHBOARD_TOUR_ID : CATALOG_TOUR_ID,
        lastStepId: stepId,
        index: action.stepIndex ?? 0,
      },
    });
  }
  return {
    state: surfaceWith(state, action.surface, next, action.now),
    intents,
    changed: true,
  };
}

function resetSurface(
  state: OnboardingState,
  surface: OnboardingSurfaceId,
  now: number,
): OnboardingTransition {
  const next = { ...emptySurfaceState(), updatedAt: now };
  return {
    state: surfaceWith(state, surface, next, now),
    intents: [],
    changed: true,
  };
}

function syncGoals(
  state: OnboardingState,
  action: Extract<OnboardingAction, { type: "sync-goals" }>,
): OnboardingTransition {
  const completed = unique(
    action.completedStepIds.filter((id) =>
      CHECKLIST_STEPS.some((step) => step.id === id),
    ),
  );
  const same =
    completed.length === state.goals.completedStepIds.length &&
    completed.every((id) => state.goals.completedStepIds.includes(id));
  if (same && state.goals.fetchedAt === action.fetchedAt) {
    return { state, intents: [], changed: false };
  }
  const previousCompleted = new Set(state.goals.completedStepIds);
  const newlyCompleted = completed.filter((id) => !previousCompleted.has(id));
  const checklist = state.surfaces.checklist;
  const allComplete = completed.length === CHECKLIST_STEPS.length;
  const reconciledOutcome: OnboardingOutcome = allComplete
    ? "completed"
    : checklist.outcome === "completed"
      ? "in-progress"
      : checklist.outcome;
  const nextChecklist: OnboardingSurfaceState = {
    ...checklist,
    outcome: reconciledOutcome,
    completedStepIds: completed,
    skippedStepIds: checklist.skippedStepIds.filter(
      (id) => !completed.includes(id as ChecklistStepId),
    ),
    currentStepId: allComplete ? null : checklist.currentStepId,
    updatedAt: action.now,
  };
  const nextState: OnboardingState = {
    ...state,
    revision: state.revision + 1,
    updatedAt: action.now,
    goals: {
      completedStepIds: completed,
      fetchedAt: action.fetchedAt,
      updatedAt: action.now,
    },
    surfaces: { ...state.surfaces, checklist: nextChecklist },
  };
  const intents: OnboardingAnalyticsIntent[] = [];
  if (action.announceChanges) {
    for (const id of newlyCompleted) {
      const goalKey = CHECKLIST_STEPS.find((step) => step.id === id)?.goalKey;
      if (goalKey) {
        intents.push({
          name: "onboarding.checklist_goal_completed",
          props: { key: goalKey },
        });
      }
    }
    if (
      allComplete &&
      state.goals.completedStepIds.length < CHECKLIST_STEPS.length
    ) {
      intents.push({
        name: "onboarding.checklist_completed",
        props: { total: CHECKLIST_STEPS.length },
      });
      intents.push({
        name: "onboarding.milestone_celebrated",
        props: { milestone: "onboarding_complete" },
      });
    }
  }
  return { state: nextState, intents, changed: true };
}

export function transitionOnboardingState(
  state: OnboardingState,
  action: OnboardingAction,
): OnboardingTransition {
  switch (action.type) {
    case "open":
      return openSurface(state, action);
    case "set-step":
      return changeStep(state, action);
    case "complete-step":
    case "skip-step":
      return resolveStep(state, action);
    case "complete-surface":
    case "skip-surface":
    case "dismiss-surface":
      return finishSurface(state, action);
    case "reset-surface":
      return resetSurface(state, action.surface, action.now);
    case "reset-all": {
      const reset = createOnboardingState(state.scopeToken);
      return {
        state: {
          ...reset,
          revision: state.revision + 1,
          updatedAt: action.now,
          surfaces: Object.fromEntries(
            ONBOARDING_SURFACE_IDS.map((surface) => [
              surface,
              { ...reset.surfaces[surface], updatedAt: action.now },
            ]),
          ) as Record<OnboardingSurfaceId, OnboardingSurfaceState>,
          goals: state.goals,
        },
        intents: [],
        changed: true,
      };
    }
    case "sync-goals":
      return syncGoals(state, action);
  }
}

export function isTerminalOutcome(outcome: OnboardingOutcome): boolean {
  return (
    outcome === "completed" ||
    outcome === "skipped" ||
    outcome === "dismissed"
  );
}

export function nextOnboardingStep(
  surface: OnboardingSurfaceId,
  currentStepId: OnboardingStepId | null,
  role: Role | null | undefined,
): OnboardingStepId | null {
  const steps = onboardingStepsForRole(surface, role);
  if (steps.length === 0) return null;
  const index = steps.findIndex((step) => step.id === currentStepId);
  if (index < 0) return steps[0]?.id ?? null;
  return steps[index + 1]?.id ?? null;
}

export interface OnboardingEligibilityContext {
  role: Role | null | undefined;
  blocked: boolean;
  /** null means the server/cache could not establish workspace progress. */
  workspaceNeedsSetup: boolean | null;
}

export function shouldAutoOpenOnboardingSurface(
  state: OnboardingState,
  surface: OnboardingSurfaceId,
  context: OnboardingEligibilityContext,
): boolean {
  if (
    context.blocked ||
    !isOnboardingSurfaceApplicable(surface, context.role)
  ) {
    return false;
  }
  const record = state.surfaces[surface];
  if (record.outcome === "in-progress") return true;
  if (isTerminalOutcome(record.outcome)) return false;
  if (surface === "wizard") return context.workspaceNeedsSetup === true;
  if (surface === "tour") {
    const wizardSettled =
      !isOnboardingSurfaceApplicable("wizard", context.role) ||
      isTerminalOutcome(state.surfaces.wizard.outcome) ||
      context.workspaceNeedsSetup === false;
    return wizardSettled && context.workspaceNeedsSetup !== null;
  }
  return false;
}
