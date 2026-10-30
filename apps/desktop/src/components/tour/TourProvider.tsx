import {
  adaptiveSteps,
  type ChecklistGoalKey,
} from "@postwave/onboarding-schema";
import {
  createContext,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useOnboardingProgress } from "../../hooks/useOnboardingProgress";
import {
  useOnboardingState,
  useOnboardingUiBlockers,
} from "../../hooks/useOnboardingState";
import { navigateDesktopRoute } from "../../lib/desktop-router";
import {
  CHECKLIST_STEPS,
  type ChecklistStepId,
} from "../../lib/onboarding-manifest";
import { shouldAutoOpenOnboardingSurface } from "../../lib/onboarding-state-machine";
import { ConfirmModal } from "../ConfirmModal";
import { DASHBOARD_TOUR_STEPS } from "./dashboardTour";
import { TourOverlay } from "./TourOverlay";
import { TourTooltip } from "./TourTooltip";
import type { TourController, TourStep } from "./types";

const TOUR_DIALOG_ID = "onboarding:tour";
const TourContext = createContext<TourController | null>(null);
const FIRST_SEND_STEPS: readonly ChecklistStepId[] = [
  "verify-domain",
  "import-subscribers",
  "send-first-campaign",
];

interface ResolvedTourTarget {
  element: HTMLElement | null;
  rect: DOMRect | null;
  stepId: TourStep["id"];
  unavailable: boolean;
}

function resolveTarget(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-tour="' + selector + '"]');
}

function workspaceNeedsSetup(
  progress: ReturnType<typeof useOnboardingProgress>,
): boolean | null {
  if (!progress.available) return null;
  return FIRST_SEND_STEPS.some((id) => !progress.completedStepIds.includes(id));
}

export function useTour(): TourController {
  const context = useContext(TourContext);
  if (!context) throw new Error("useTour() must be used inside TourProvider");
  return context;
}

interface ProviderProps {
  children: ReactNode;
}

type TourMode = "quick" | "full";

function isFullWorkspaceStep(stepId: string | null | undefined): boolean {
  return stepId?.startsWith("workspace-") === true;
}

export function TourProvider({ children }: ProviderProps): ReactElement {
  const onboarding = useOnboardingState();
  const progress = useOnboardingProgress();
  const blockers = useOnboardingUiBlockers(TOUR_DIALOG_ID);
  const record = onboarding.state.surfaces.tour;
  const quickSteps = useAdaptiveTourSteps(progress);
  const [requestedMode, setRequestedMode] = useState<TourMode>(() =>
    isFullWorkspaceStep(record.currentStepId) ? "full" : "quick",
  );
  const [fullSteps, setFullSteps] = useState<TourStep[] | null>(null);
  // A persisted full walkthrough must restore against the full manifest on
  // the very render that server-backed onboarding state arrives. Waiting for
  // an effect would briefly fail to resolve the step and reset it to quick.
  const mode: TourMode =
    record.outcome === "in-progress" &&
    isFullWorkspaceStep(record.currentStepId)
      ? "full"
      : requestedMode;
  const steps = mode === "full" ? (fullSteps ?? []) : quickSteps;
  const currentStep = steps.findIndex(
    (step) => step.id === record.currentStepId,
  );
  /**
   * Did the tour start HERE, in this session, because someone asked for it?
   *
   * The distinction the anti-flash gate below turns on. A tour restored from
   * local storage is this device's guess at an answer that lives on the server;
   * a tour the person just started from Help is the answer.
   */
  const openedHereRef = useRef(false);
  const isOpen =
    record.outcome === "in-progress" &&
    currentStep >= 0 &&
    currentStep < steps.length &&
    // DO NOT FLASH. `record` is read from a per-device cache, so before the
    // decisions arrive it can say "in progress" for a tour this person put away
    // on another device — showing it and then tearing it down when the
    // dismissal lands is worse than the bug this gate exists to fix. Silence is
    // the honest pre-load state for a surface that interrupts: an unanswered
    // question is not a "yes". A hand-started tour is exempt because it is not
    // waiting on an answer — it IS one.
    (onboarding.decisionsSettled || openedHereRef.current);
  const suspended = isOpen && blockers.blocked;
  const [resolvedTarget, setResolvedTarget] =
    useState<ResolvedTourTarget | null>(null);
  const [skipPending, setSkipPending] = useState(false);
  const navGenerationRef = useRef(0);
  const transitionRef = useRef<TourStep["id"] | null>(null);
  const stepEnteredAtRef = useRef<number | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const step = isOpen ? (steps[currentStep] ?? null) : null;
  const target =
    step && resolvedTarget?.stepId === step.id ? resolvedTarget : null;

  useEffect(() => {
    if (mode !== "full" || fullSteps !== null) return;
    let active = true;
    void import("./workspaceTour").then((module) => {
      if (active) setFullSteps(module.FULL_WORKSPACE_TOUR_STEPS);
    });
    return () => {
      active = false;
    };
  }, [fullSteps, mode]);

  useEffect(() => {
    if (record.outcome !== "in-progress" || currentStep >= 0) return;
    if (mode === "full" && fullSteps === null) return;
    const first = steps[0];
    if (first) onboarding.setStep("tour", first.id, 0);
  }, [currentStep, fullSteps, mode, onboarding, record.outcome, steps]);

  useEffect(() => {
    if (
      !onboarding.ready ||
      // The tour may not auto-open until this person's decision has been
      // consulted. `not-started` in local storage is the absence of a LOCAL
      // answer, and on a device they have never toured on that is exactly what
      // a dismissal made elsewhere looks like — which is how the tour came to
      // re-run on every new device, once per device, forever.
      !onboarding.decisionsSettled ||
      progress.loading ||
      !progress.liveConfirmed ||
      record.outcome !== "not-started"
    ) {
      return;
    }
    const eligible = shouldAutoOpenOnboardingSurface(onboarding.state, "tour", {
      role: onboarding.role,
      blocked: blockers.blocked,
      workspaceNeedsSetup: workspaceNeedsSetup(progress),
    });
    if (!eligible) return;
    const timer = window.setTimeout(() => {
      const first = steps[0];
      if (first) {
        openedHereRef.current = true;
        onboarding.openSurface("tour", "auto", first.id, {
          stepCount: steps.length,
          stepIndex: 0,
        });
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [blockers.blocked, onboarding, progress, record.outcome, steps]);

  useEffect(() => {
    if (!isOpen) setSkipPending(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    return () => {
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      queueMicrotask(() => {
        if (previous?.isConnected) previous.focus();
      });
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !step) {
      stepEnteredAtRef.current = null;
      return;
    }
    stepEnteredAtRef.current = Date.now();
  }, [isOpen, step?.id]);

  const elapsedOnStep = useCallback((): number => {
    const enteredAt = stepEnteredAtRef.current;
    return enteredAt == null ? 0 : Math.max(0, Date.now() - enteredAt);
  }, []);
  const claimTransition = useCallback((stepId: TourStep["id"]): boolean => {
    if (transitionRef.current === stepId) return false;
    transitionRef.current = stepId;
    queueMicrotask(() => {
      if (transitionRef.current === stepId) transitionRef.current = null;
    });
    return true;
  }, []);

  const start = useCallback((): void => {
    if (record.outcome === "in-progress") return;
    const first = quickSteps[0];
    if (!first) return;
    if (!claimTransition(first.id)) return;
    setRequestedMode("quick");
    openedHereRef.current = true;
    onboarding.openSurface("tour", "manual", first.id, {
      stepCount: quickSteps.length,
      stepIndex: 0,
    });
  }, [claimTransition, onboarding, quickSteps, record.outcome]);

  const replay = useCallback((): void => {
    const first = quickSteps[0];
    if (!first) return;
    if (!claimTransition(first.id)) return;
    setRequestedMode("quick");
    openedHereRef.current = true;
    onboarding.resetSurface("tour");
    onboarding.openSurface("tour", "manual", first.id, {
      stepCount: quickSteps.length,
      stepIndex: 0,
    });
  }, [claimTransition, onboarding, quickSteps]);

  const fullWalkthrough = useCallback((): void => {
    void import("./workspaceTour").then((module) => {
      const loaded = module.FULL_WORKSPACE_TOUR_STEPS;
      const first = loaded[0];
      if (!first || !claimTransition(first.id)) return;
      setFullSteps(loaded);
      setRequestedMode("full");
      openedHereRef.current = true;
      onboarding.resetSurface("tour");
      onboarding.openSurface("tour", "manual", first.id, {
        stepCount: loaded.length,
        stepIndex: 0,
      });
    });
  }, [claimTransition, onboarding]);

  const next = useCallback((): void => {
    if (!step || currentStep < 0 || currentStep >= steps.length - 1) return;
    const nextStep = steps[currentStep + 1];
    if (!nextStep) return;
    if (!claimTransition(step.id)) return;
    onboarding.completeStep("tour", step.id, nextStep.id, {
      nextStepIndex: currentStep + 1,
      stepCount: steps.length,
      msOnStep: elapsedOnStep(),
    });
  }, [claimTransition, currentStep, elapsedOnStep, onboarding, step, steps]);

  const back = useCallback((): void => {
    if (currentStep <= 0) return;
    const previous = steps[currentStep - 1];
    if (!previous) return;
    if (!step || !claimTransition(step.id)) return;
    onboarding.setStep("tour", previous.id, currentStep - 1, elapsedOnStep());
  }, [claimTransition, currentStep, elapsedOnStep, onboarding, step, steps]);

  const complete = useCallback((): void => {
    if (!step || !claimTransition(step.id)) return;
    onboarding.completeSurface(
      "tour",
      record.openedAt == null ? 0 : Date.now() - record.openedAt,
    );
  }, [claimTransition, onboarding, record.openedAt, step]);

  const skip = useCallback((): void => setSkipPending(true), []);
  const confirmSkip = useCallback((): void => {
    if (step) {
      onboarding.skipStep("tour", step.id, undefined, {
        nextStepIndex: currentStep + 1,
        stepCount: steps.length,
        msOnStep: elapsedOnStep(),
      });
      onboarding.skipSurface("tour", step.id, currentStep);
    } else {
      onboarding.skipSurface("tour");
    }
    setSkipPending(false);
  }, [currentStep, elapsedOnStep, onboarding, step, steps.length]);

  useTourTarget({
    isOpen,
    suspended,
    step,
    navGenerationRef,
    setResolvedTarget,
  });

  const controller = useMemo<TourController>(
    () => ({
      currentStep: isOpen ? currentStep : -1,
      totalSteps: steps.length,
      isOpen,
      start,
      replay,
      fullWalkthrough,
      next,
      back,
      skip,
      complete,
    }),
    [
      back,
      complete,
      currentStep,
      fullWalkthrough,
      isOpen,
      next,
      replay,
      skip,
      start,
      steps.length,
    ],
  );

  return (
    <TourContext.Provider value={controller}>
      {children}
      {isOpen && step && target && !suspended ? (
        <>
          <TourOverlay rect={target.rect} />
          <TourTooltip
            step={step}
            stepIndex={currentStep}
            totalSteps={steps.length}
            rect={target.rect}
            target={target.element}
            targetUnavailable={target.unavailable}
            ownerId={TOUR_DIALOG_ID}
            onNext={next}
            onBack={back}
            onSkip={skip}
            onComplete={complete}
          />
        </>
      ) : null}
      <ConfirmModal
        open={skipPending}
        title="Skip the tour?"
        description="Your completed and skipped steps are retained. Start again from Product walkthroughs in Settings, or use Help for the quick tour."
        confirmLabel="Skip tour"
        onConfirm={confirmSkip}
        onClose={() => setSkipPending(false)}
      />
    </TourContext.Provider>
  );
}

function useAdaptiveTourSteps(
  progress: ReturnType<typeof useOnboardingProgress>,
): TourStep[] {
  const isGoalDone = useCallback(
    (key: ChecklistGoalKey): boolean => {
      const manifestStep = CHECKLIST_STEPS.find(
        (manifest) => manifest.goalKey === key,
      );
      return manifestStep
        ? progress.completedStepIds.includes(manifestStep.id)
        : false;
    },
    [progress.completedStepIds],
  );
  return useMemo(() => {
    const kept = adaptiveSteps(
      DASHBOARD_TOUR_STEPS.map((step) => ({
        id: step.id,
        title: step.title,
        body: step.body,
        skipIfGoalDone: step.skipIfGoalDone,
      })),
      isGoalDone,
    );
    const keptIds = new Set(kept.map((step) => step.id));
    return DASHBOARD_TOUR_STEPS.filter((step) => keptIds.has(step.id));
  }, [isGoalDone]);
}

interface TourTargetOptions {
  isOpen: boolean;
  suspended: boolean;
  step: TourStep | null;
  navGenerationRef: { current: number };
  setResolvedTarget: Dispatch<SetStateAction<ResolvedTourTarget | null>>;
}

function useTourTarget(options: TourTargetOptions): void {
  useEffect(() => {
    if (!options.isOpen || options.suspended || !options.step) {
      options.setResolvedTarget(null);
      return;
    }
    const step = options.step;
    const generation = ++options.navGenerationRef.current;
    options.setResolvedTarget(null);
    if (step.navigateTo) {
      try {
        navigateDesktopRoute({ section: step.navigateTo });
      } catch {
        options.setResolvedTarget({
          element: null,
          rect: null,
          stepId: step.id,
          unavailable: true,
        });
        return;
      }
    }
    if (step.targetSelector === null) {
      options.setResolvedTarget({
        element: null,
        rect: null,
        stepId: step.id,
        unavailable: false,
      });
      return;
    }

    let active = true;
    let frameOne = 0;
    let frameTwo = 0;
    let measureScheduled = false;
    let timer = 0;
    let attempts = 0;
    let didScroll = false;
    let observedTarget: HTMLElement | null = null;
    let mutationObserving = false;
    let observer: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;

    const publish = (
      element: HTMLElement | null,
      rect: DOMRect | null,
      unavailable: boolean,
    ): void => {
      if (!active || generation !== options.navGenerationRef.current) {
        return;
      }
      options.setResolvedTarget((current) => {
        if (
          current?.stepId === step.id &&
          current.element === element &&
          current.unavailable === unavailable &&
          sameRect(current.rect, rect)
        ) {
          return current;
        }
        return { element, rect, stepId: step.id, unavailable };
      });
    };

    const measure = (allowRetry: boolean): void => {
      if (!active || generation !== options.navGenerationRef.current) return;
      const target = resolveTarget(step.targetSelector!);
      const rect = target?.getBoundingClientRect() ?? null;
      if (target && rect && rect.width > 0 && rect.height > 0) {
        if (observedTarget !== target) {
          observer?.disconnect();
          observer?.observe(target);
          observedTarget = target;
        }
        if (!mutationObserving) {
          mutationObserver?.observe(document.body, {
            childList: true,
            subtree: true,
          });
          mutationObserving = true;
        }
        const viewport = {
          height: window.visualViewport?.height ?? window.innerHeight,
          left: window.visualViewport?.offsetLeft ?? 0,
          top: window.visualViewport?.offsetTop ?? 0,
          width: window.visualViewport?.width ?? window.innerWidth,
        };
        const outsideViewport =
          rect.bottom < viewport.top ||
          rect.top > viewport.top + viewport.height ||
          rect.right < viewport.left ||
          rect.left > viewport.left + viewport.width;
        if (
          outsideViewport &&
          !didScroll &&
          typeof target.scrollIntoView === "function"
        ) {
          didScroll = true;
          target.scrollIntoView({ block: "center", inline: "nearest" });
          scheduleMeasure(false);
          return;
        }
        publish(target, rect, false);
        return;
      }
      if (!allowRetry) {
        publish(null, null, true);
        return;
      }
      attempts += 1;
      if (attempts > 12) {
        if (!mutationObserving) {
          mutationObserver?.observe(document.body, {
            childList: true,
            subtree: true,
          });
          mutationObserving = true;
        }
        publish(null, null, true);
        return;
      }
      timer = window.setTimeout(() => measure(true), 100);
    };
    const scheduleMeasure = (allowRetry: boolean): void => {
      if (measureScheduled) return;
      measureScheduled = true;
      frameTwo = window.requestAnimationFrame(() => {
        measureScheduled = false;
        frameTwo = 0;
        measure(allowRetry);
      });
    };
    const refresh = (): void => scheduleMeasure(false);
    observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(refresh);
    mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(refresh);
    frameOne = window.requestAnimationFrame(() => scheduleMeasure(true));
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    window.visualViewport?.addEventListener("resize", refresh);
    window.visualViewport?.addEventListener("scroll", refresh);
    return () => {
      active = false;
      if (options.navGenerationRef.current === generation) {
        options.navGenerationRef.current += 1;
      }
      window.cancelAnimationFrame(frameOne);
      window.cancelAnimationFrame(frameTwo);
      if (timer) window.clearTimeout(timer);
      observer?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
      window.visualViewport?.removeEventListener("resize", refresh);
      window.visualViewport?.removeEventListener("scroll", refresh);
    };
  }, [
    options.isOpen,
    options.navGenerationRef,
    options.setResolvedTarget,
    options.step,
    options.suspended,
  ]);
}

function sameRect(left: DOMRect | null, right: DOMRect | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.top === right.top &&
    left.right === right.right &&
    left.bottom === right.bottom &&
    left.left === right.left &&
    left.width === right.width &&
    left.height === right.height
  );
}
