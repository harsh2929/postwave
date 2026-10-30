import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "react-native-reanimated";

import {
  TOUR_DISMISSED_AT_KEY,
  isTourDismissed,
} from "@/lib/onboardingDecisions";

import { tourAutoLaunchDecision } from "./tourAutoLaunch";
import { normalizeStoredTourStep } from "./tourPersistence";

export const TOUR_STORAGE_KEYS = {
  completedAt: "postwave_tour_dashboard_completed_at",
  step: "postwave_tour_dashboard_step",
  // Sourced, not respelled. This literal used to live here AND in the desktop
  // and web tours; one rename in one place would have split a shared decision
  // back into unshared ones, each client writing a key the others never read.
  dismissedAt: TOUR_DISMISSED_AT_KEY,
} as const;

interface TourLaunchLifecycleOptions {
  disableAutoLaunch: boolean;
  onAutoLaunch: (stepIndex: number) => void;
  onManualLaunch: () => void;
  progressCompleted: unknown;
  progressFailed: boolean;
  progressLoading: boolean;
  ready: boolean;
  stepCount: number;
}

/** Owns launch precedence, persistence hydration, and reduced-motion state. */
export function useTourLaunchLifecycle({
  disableAutoLaunch,
  onAutoLaunch,
  onManualLaunch,
  progressCompleted,
  progressFailed,
  progressLoading,
  ready,
  stepCount,
}: TourLaunchLifecycleOptions): {
  hydrated: boolean;
  reducedMotion: boolean;
  start: () => void;
} {
  const [hydrated, setHydrated] = useState(false);
  // One source for the preference (reanimated's hook), rather than a third
  // AccessibilityInfo read raced against AsyncStorage in the effect below.
  const reducedMotion = useReducedMotion();
  const autoLaunchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A known-empty workspace suppresses automatic launch for this provider
  // session, even after the wizard completes its first task. Manual Replay
  // deliberately bypasses this latch.
  const autoLaunchHandledRef = useRef(false);
  const automaticLaunchDecision = tourAutoLaunchDecision({
    completed: progressCompleted,
    failed: progressFailed,
    // A disabled/paused query may remain pending indefinitely. Only a real
    // first fetch should delay the fail-soft automatic tour.
    pending: progressLoading,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [completedAt, storedStep] = await Promise.all([
          AsyncStorage.getItem(TOUR_STORAGE_KEYS.completedAt),
          AsyncStorage.getItem(TOUR_STORAGE_KEYS.step),
        ]);
        if (cancelled) return;
        if (disableAutoLaunch || !ready || completedAt != null) return;
        if (autoLaunchHandledRef.current) return;

        // Give the first-run wizard precedence while progress is in flight.
        // An authoritative zero latches suppression; endpoint failure retains
        // the tour's historical fail-soft behavior.
        if (automaticLaunchDecision === "wait") return;
        if (automaticLaunchDecision === "suppress") {
          autoLaunchHandledRef.current = true;
          return;
        }

        const dismissed = await isTourDismissed();
        if (cancelled || autoLaunchHandledRef.current) return;
        autoLaunchHandledRef.current = true;
        if (!dismissed) {
          // Let the dashboard mount and register spotlight targets first.
          autoLaunchTimerRef.current = setTimeout(() => {
            if (cancelled) return;
            onAutoLaunch(normalizeStoredTourStep(storedStep, stepCount));
          }, 600);
        }
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();

    return () => {
      cancelled = true;
      if (autoLaunchTimerRef.current) {
        clearTimeout(autoLaunchTimerRef.current);
        autoLaunchTimerRef.current = null;
      }
    };
  }, [
    automaticLaunchDecision,
    disableAutoLaunch,
    onAutoLaunch,
    ready,
    stepCount,
  ]);

  const start = useCallback(() => {
    autoLaunchHandledRef.current = true;
    if (autoLaunchTimerRef.current) {
      clearTimeout(autoLaunchTimerRef.current);
      autoLaunchTimerRef.current = null;
    }
    onManualLaunch();
    void AsyncStorage.setItem(TOUR_STORAGE_KEYS.step, "0").catch(
      () => undefined,
    );
  }, [onManualLaunch]);

  return { hydrated, reducedMotion, start };
}
