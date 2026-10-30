/**
 * useHydrationGate — decides when the app may paint, and refuses to wait
 * forever (SHELL#62).
 *
 * The old rule was `if (!ready) return null` with `ready = hydrated &&
 * (fontsLoaded || fontError)` and `SplashScreen.preventAutoHideAsync()` at
 * module load. A font failure was handled; an auth-hydration failure was not.
 * If `hydrate()` never settles — a SecureStore/Keychain fault, a device still
 * locked after a reboot, a vault manifest the store cannot parse — the user is
 * left on the splash screen with no message, no error and no way out. The only
 * user-side remedy for that is deleting the app.
 *
 * So: bounded wait, then proceed with a STATED degraded state. The decision
 * itself lives in `lib/startupGate.ts` (import-free, unit-tested); this hook
 * owns the timer, the fonts, and the one-shot splash dismissal.
 */
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useRef, useState } from "react";

import { EVENTS } from "@postwave/telemetry";

import { fontAssets } from "@/lib/fonts";
import {
  STARTUP_WATCHDOG_MS,
  startupGateState,
  startupOutcome,
  type StartupDegradation,
} from "@/lib/startupGate";
import { track as trackTelemetry } from "@/lib/telemetry";
import { useAuthStore } from "@/store/auth";

export interface HydrationGate {
  /** SecureStore answered. False here does NOT mean "signed out". */
  hydrated: boolean;
  /** Render the app; the splash has been (or is being) dismissed. */
  proceed: boolean;
  /** Non-null when we proceeded before a concern finished. */
  degraded: StartupDegradation | null;
}

export function useHydrationGate(): HydrationGate {
  const hydrated = useAuthStore((s) => s.hydrated);
  // Brand fonts (Inter body + Fraunces display). A load FAILURE counts as
  // settled — a font CDN hiccup must never brick launch.
  const [fontsLoaded, fontError] = useFonts(fontAssets);
  const fontsSettled = fontsLoaded || Boolean(fontError);
  const [watchdogElapsed, setWatchdogElapsed] = useState(false);

  const settled = hydrated && fontsSettled;
  useEffect(() => {
    if (settled || watchdogElapsed) return;
    const timer = setTimeout(
      () => setWatchdogElapsed(true),
      STARTUP_WATCHDOG_MS,
    );
    return () => clearTimeout(timer);
  }, [settled, watchdogElapsed]);

  const gate = startupGateState({ hydrated, fontsSettled, watchdogElapsed });

  // Dismiss the splash and report the launch exactly ONCE per process. The
  // outcome carries the degradation, so a hung hydration is measurable instead
  // of being invisible in the field.
  const launchReported = useRef(false);
  useEffect(() => {
    if (!gate.proceed || launchReported.current) return;
    launchReported.current = true;
    void SplashScreen.hideAsync();
    trackTelemetry(EVENTS.MOBILE_APP_OPENED, {
      outcome: startupOutcome(gate.degraded),
    });
  }, [gate.proceed, gate.degraded]);

  return { hydrated, proceed: gate.proceed, degraded: gate.degraded };
}
