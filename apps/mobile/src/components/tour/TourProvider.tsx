/**
 * TourProvider — context, state machine, and ref registry for the
 * Moosewave mobile product tour.
 *
 * Responsibilities:
 *
 *  1. Holds the tour script (default: DASHBOARD_TOUR), the active step
 *     index, and active flag. Exposes `start / next / back / skip /
 *     dismiss` to consumers.
 *
 *  2. Maintains a Map<TourTargetId, RefObject<View>> populated via the
 *     `useTourTarget` hook. Screens register their refs on mount and
 *     unregister on unmount; the overlay reads them when a step
 *     activates and calls `measureInWindow` to position the spotlight.
 *
 *  3. Persists completion + dismissal so the tour auto-launches exactly
 *     once for new users. Storage keys:
 *
 *       postwave_tour_dashboard_completed_at   ISO string | null
 *       postwave_tour_dashboard_step           number | null
 *       postwave_tour_dashboard_dismissed_at   ISO string | null
 *
 *     DISMISSAL IS NO LONGER THIS DEVICE'S TO HOLD. All three clients
 *     kept their own `postwave_tour_dashboard_dismissed_at`, so a person
 *     skipped the tour on their laptop, opened the phone, and it ran
 *     again — the product asking a question that had already been
 *     answered, once per device. The decision now lives server-side
 *     under the shared `dashboard_tour` step key
 *     (`GET/PUT /api/v1/onboarding/steps`), reached through the same
 *     module the checklist uses (`@/lib/onboardingDecisions`). The
 *     AsyncStorage key survives as a CACHE — first paint, offline, and
 *     the answers made before this shipped — never as the authority.
 *
 *     COMPLETION stays per-device on purpose: the decision vocabulary
 *     (dismissed | snoozed | skipped | inapplicable | delegated) has no
 *     "completed", and it names what a HUMAN decided, not what they
 *     finished. Syncing that needs one answer agreed across all three
 *     clients, not a fourth meaning invented here.
 *
 *  4. Learns the Reduce Motion preference through reanimated's
 *     `useReducedMotion()` (the app's one source for it, via the launch
 *     lifecycle hook) so the tooltip + spotlight components can drop
 *     animations to instant when the user asks the OS for that.
 *
 *  5. Renders the <TourOverlay> as the last child so it paints on top
 *     of all routes.
 *
 * Why a single-script provider rather than a generic engine? The
 * mobile surface area is small enough that one script suffices, and
 * the simpler API keeps screen integrations lightweight (one hook
 * call per target).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { View } from "react-native";

import { adaptiveSteps, DASHBOARD_TOUR_ID } from "@postwave/onboarding-schema";

import { useOnboardingProgressQuery } from "@/components/onboarding/useOnboardingProgress";
import {
  ONBOARDING_EVENTS,
  trackOnboarding,
} from "@/components/onboarding/analytics";
import { dismissTour } from "@/lib/onboardingDecisions";

import { DASHBOARD_TOUR } from "./dashboardTour";
import { TourOverlay } from "./TourOverlay";
import type {
  TourContextValue,
  TourStep,
  TourTarget,
  TourTargetId,
} from "./types";
import {
  TOUR_STORAGE_KEYS,
  useTourLaunchLifecycle,
} from "./useTourLaunchLifecycle";

export { TOUR_STORAGE_KEYS } from "./useTourLaunchLifecycle";

// The shared id, not a mobile-specific one. Emitting "mobile_dashboard" split
// this tour into a funnel that could never be compared with desktop's, to carry
// a surface distinction the `platform` field on every onboarding event already
// carries.
const TOUR_ID = DASHBOARD_TOUR_ID;

const TourContext = createContext<TourContextValue | null>(null);

interface TourProviderProps {
  children: ReactNode;
  /** Override the script (mainly for tests). */
  steps?: readonly TourStep[];
  /**
   * If true, the tour will not auto-launch even when storage is empty.
   * Useful for screenshot tests + storybook-style harnesses.
   */
  disableAutoLaunch?: boolean;
  /**
   * Gate auto-launch on app readiness — e.g. only after auth has
   * hydrated and the user has landed on the dashboard. The host passes
   * `true` once it's safe to fire.
   */
  ready?: boolean;
}

export function TourProvider({
  children,
  steps = DASHBOARD_TOUR,
  disableAutoLaunch = false,
  ready = true,
}: TourProviderProps) {
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  // Adaptive tours: drop steps whose onboarding goal the tenant already
  // finished. Progress comes from the shared /onboarding-progress query
  // (cached + deduped with the dashboard checklist). While progress is
  // absent (loading / older API / logged out) we fall back to the full
  // script — never hiding steps on missing data.
  const progressQuery = useOnboardingProgressQuery();
  const progress = progressQuery.data;
  // Live adaptive filter — recomputed as progress changes while the tour is idle.
  const liveSteps = useMemo<readonly TourStep[]>(() => {
    if (!progress) return steps;
    const filtered = adaptiveSteps(
      steps as unknown as Parameters<typeof adaptiveSteps>[0],
      (key) => progress.steps.some((s) => s.key === key && s.completed),
    );
    return filtered as unknown as readonly TourStep[];
  }, [steps, progress]);
  // FROZEN for the lifetime of an active run: snapshot the list when the tour
  // opens and keep it stable even if progress resolves mid-tour. Re-filtering
  // live would shift/drop the step the user is on (index drift → wrong step
  // shown / mis-attributed analytics). Resets when the tour closes.
  const frozenStepsRef = useRef<readonly TourStep[] | null>(null);
  const effectiveSteps = useMemo<readonly TourStep[]>(() => {
    if (active) {
      if (frozenStepsRef.current == null) frozenStepsRef.current = liveSteps;
      return frozenStepsRef.current;
    }
    frozenStepsRef.current = null;
    return liveSteps;
  }, [active, liveSteps]);

  // Use a ref for the registry so registerTarget doesn't trigger a
  // re-render of every consumer. The overlay reads via getTarget when
  // a step activates — it doesn't need to subscribe to changes.
  const targetsRef = useRef<Map<TourTargetId, TourTarget>>(new Map());
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Analytics timing: wall-clock when the tour started + when the current
  // step became visible, so tour_completed / step_viewed carry durations.
  const startedAtRef = useRef<number | null>(null);
  const stepShownAtRef = useRef<number | null>(null);
  const triggerRef = useRef<"auto" | "manual">("manual");

  const handleAutoLaunch = useCallback((storedStepIndex: number) => {
    triggerRef.current = "auto";
    setStepIndex(storedStepIndex);
    setActive(true);
  }, []);

  const handleManualLaunch = useCallback(() => {
    triggerRef.current = "manual";
    setStepIndex(0);
    setActive(true);
  }, []);

  const { hydrated, reducedMotion, start } = useTourLaunchLifecycle({
    disableAutoLaunch,
    onAutoLaunch: handleAutoLaunch,
    onManualLaunch: handleManualLaunch,
    progressCompleted: progress?.completed,
    progressFailed: progressQuery.isError,
    progressLoading: progressQuery.isLoading,
    ready,
    stepCount: liveSteps.length,
  });

  // The hydration effect intentionally re-runs once progress settles. Keep a
  // manual tour's completion timer out of that cleanup: otherwise resolving
  // onboarding-progress mid-Replay would cancel the outro close and strand the
  // overlay. This unmount-only cleanup still prevents a late state update.
  useEffect(
    () => () => {
      if (completionTimerRef.current) {
        clearTimeout(completionTimerRef.current);
        completionTimerRef.current = null;
      }
    },
    [],
  );

  const dismiss = useCallback(() => {
    setActive(false);
  }, []);

  const next = useCallback(() => {
    setStepIndex((prev) => {
      const last = effectiveSteps.length - 1;
      if (prev >= last) {
        // Completion path: mark complete + close.
        void AsyncStorage.setItem(
          TOUR_STORAGE_KEYS.completedAt,
          new Date().toISOString(),
        ).catch(() => undefined);
        void AsyncStorage.removeItem(TOUR_STORAGE_KEYS.step).catch(
          () => undefined,
        );
        trackOnboarding(ONBOARDING_EVENTS.tourCompleted, {
          tourId: TOUR_ID,
          totalMs:
            startedAtRef.current != null
              ? Date.now() - startedAtRef.current
              : 0,
        });
        // Defer setActive(false) so the outro confetti gets a beat to
        // play before the overlay unmounts.
        if (completionTimerRef.current) {
          clearTimeout(completionTimerRef.current);
        }
        completionTimerRef.current = setTimeout(() => {
          setActive(false);
          completionTimerRef.current = null;
        }, 1800);
        return prev;
      }
      const nextIndex = prev + 1;
      void AsyncStorage.setItem(
        TOUR_STORAGE_KEYS.step,
        String(nextIndex),
      ).catch(() => undefined);
      return nextIndex;
    });
  }, [effectiveSteps.length]);

  const back = useCallback(() => {
    setStepIndex((prev) => {
      const nextIndex = Math.max(0, prev - 1);
      void AsyncStorage.setItem(
        TOUR_STORAGE_KEYS.step,
        String(nextIndex),
      ).catch(() => undefined);
      return nextIndex;
    });
  }, []);

  const skip = useCallback(() => {
    // Records the decision for this PERSON, not this device: writing only the
    // local key meant the tour ran again on every other surface they own.
    // Deliberately not awaited — the overlay closes on this tick, and the
    // local write inside lands first so an offline skip is honoured on the
    // next cold start and pushed to the server when one is next reachable.
    void dismissTour();
    const cur = effectiveSteps[stepIndex];
    trackOnboarding(ONBOARDING_EVENTS.tourStepSkipped, {
      tourId: TOUR_ID,
      stepId: cur?.id ?? "unknown",
      index: stepIndex,
    });
    trackOnboarding(ONBOARDING_EVENTS.tourDismissed, {
      tourId: TOUR_ID,
      lastStepId: cur?.id ?? "unknown",
      index: stepIndex,
    });
    setActive(false);
  }, [effectiveSteps, stepIndex]);

  const registerTarget = useCallback(
    (id: TourTargetId, ref: RefObject<View | null>) => {
      targetsRef.current.set(id, { id, ref });
      return () => {
        const current = targetsRef.current.get(id);
        // Only remove if it's the same ref — guards against the rare
        // unmount-after-remount race where a sibling already replaced.
        if (current?.ref === ref) {
          targetsRef.current.delete(id);
        }
      };
    },
    [],
  );

  const getTarget = useCallback(
    (id: TourTargetId) => targetsRef.current.get(id),
    [],
  );

  // ——— Analytics: tour_started (on activate) + tour_step_viewed (per step) ———
  const wasActiveRef = useRef(false);
  const lastViewedIndexRef = useRef<number>(-1);
  useEffect(() => {
    if (active && !wasActiveRef.current) {
      // Tour just opened.
      wasActiveRef.current = true;
      startedAtRef.current = Date.now();
      stepShownAtRef.current = Date.now();
      trackOnboarding(ONBOARDING_EVENTS.tourStarted, {
        tourId: TOUR_ID,
        stepCount: effectiveSteps.length,
        trigger: triggerRef.current,
      });
      const current = effectiveSteps[stepIndex];
      lastViewedIndexRef.current = stepIndex;
      if (current) {
        trackOnboarding(ONBOARDING_EVENTS.tourStepViewed, {
          tourId: TOUR_ID,
          stepId: current.id,
          index: stepIndex,
        });
      }
    } else if (!active && wasActiveRef.current) {
      // Tour closed (completed/dismissed paths already emitted their event).
      wasActiveRef.current = false;
    }
  }, [active, effectiveSteps, stepIndex]);

  // Per-step view event on advance/back while active (the first step is
  // emitted by the activate effect above, so skip index 0's duplicate).
  useEffect(() => {
    if (!active) {
      lastViewedIndexRef.current = -1;
      return;
    }
    if (stepIndex === lastViewedIndexRef.current) return;
    lastViewedIndexRef.current = stepIndex;
    const now = Date.now();
    const msOnPrev =
      stepShownAtRef.current != null ? now - stepShownAtRef.current : undefined;
    stepShownAtRef.current = now;
    const cur = effectiveSteps[stepIndex];
    if (cur) {
      trackOnboarding(ONBOARDING_EVENTS.tourStepViewed, {
        tourId: TOUR_ID,
        stepId: cur.id,
        index: stepIndex,
        ...(msOnPrev != null ? { msOnPrevStep: msOnPrev } : {}),
      });
    }
  }, [active, stepIndex, effectiveSteps]);

  const value: TourContextValue = useMemo(
    () => ({
      active,
      stepIndex,
      steps: effectiveSteps,
      start,
      dismiss,
      next,
      back,
      skip,
      registerTarget,
      getTarget,
      hydrated,
      reducedMotion,
    }),
    [
      active,
      stepIndex,
      effectiveSteps,
      start,
      dismiss,
      next,
      back,
      skip,
      registerTarget,
      getTarget,
      hydrated,
      reducedMotion,
    ],
  );

  return (
    <TourContext.Provider value={value}>
      {children}
      <TourOverlay />
    </TourContext.Provider>
  );
}

/** Read the tour context. Throws outside a TourProvider. */
export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) {
    // Soft fallback: a no-op context. Lets hooks called outside the
    // provider (e.g. tests, storybook) compile without runtime error.
    return {
      active: false,
      stepIndex: 0,
      steps: [],
      start: () => undefined,
      dismiss: () => undefined,
      next: () => undefined,
      back: () => undefined,
      skip: () => undefined,
      registerTarget: () => () => undefined,
      getTarget: () => undefined,
      hydrated: true,
      reducedMotion: false,
    };
  }
  return ctx;
}

/**
 * Hook screens use to register their key elements with the tour.
 *
 *   const ref = useRef<View>(null);
 *   useTourTarget("dashboard.stats", ref);
 *   ...
 *   <View ref={ref} ...>
 *
 * Re-registers if the ref identity changes (rare — refs are usually
 * stable). Cleans up on unmount.
 */
export function useTourTarget(
  id: TourTargetId,
  ref: RefObject<View | null>,
): void {
  const { registerTarget } = useTour();
  useEffect(() => {
    const unregister = registerTarget(id, ref);
    return unregister;
  }, [id, ref, registerTarget]);
}
