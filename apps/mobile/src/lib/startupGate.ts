/**
 * lib/startupGate.ts — the PURE launch decision: may we paint yet, and if we
 * painted early, what is broken?
 *
 * SHELL#62. The root layout used to render `null` until
 * `hydrated && (fontsLoaded || fontError)`, with
 * `SplashScreen.preventAutoHideAsync()` called at module load. Font failure was
 * handled (an error counts as settled), but hydration had no escape at all: a
 * SecureStore/Keychain fault, a device still locked after a reboot, or a vault
 * manifest the store cannot parse leaves `hydrate()` unsettled, and the user
 * sits on the splash screen forever with no message and no way out. A launch
 * screen that can hang is a launch screen that can only be fixed by deleting
 * the app.
 *
 * The rule here is "bounded wait, then proceed with a STATED degraded state":
 *
 *   - Everything settled            → paint, nothing to say.
 *   - Watchdog elapsed, auth unsettled → paint anyway. The store still reports
 *     "not hydrated", so `canEnterApp()` is false and the user lands on
 *     sign-in, which is a place they can act from. Say so, because otherwise
 *     the app looks like it silently signed them out.
 *   - Watchdog elapsed, fonts unsettled → paint in the system font and say so.
 *
 * `degraded` is DERIVED, not latched: if hydration lands late the notice
 * disappears on its own rather than lying about a resolved fault.
 *
 * Kept import-free so it is unit-testable in the node vitest environment —
 * anything that transitively imports react-native cannot be.
 */

/** Which concern was still unresolved when the watchdog let the app through. */
export type StartupDegradation = "auth" | "fonts";

/**
 * How long the splash may cover an unresolved launch. Long enough that a cold
 * Keychain read on an old device finishes normally (measured well under a
 * second), short enough that a fault is not mistaken for a slow phone.
 */
export const STARTUP_WATCHDOG_MS = 8000;

export interface StartupGateInput {
  /** The auth store answered — with or without a session. */
  hydrated: boolean;
  /** expo-font resolved OR failed; either way it will not resolve later. */
  fontsSettled: boolean;
  /** STARTUP_WATCHDOG_MS has passed since launch. */
  watchdogElapsed: boolean;
}

export interface StartupGateState {
  /** Render the app and dismiss the splash. */
  proceed: boolean;
  /** Non-null only when we proceeded WITHOUT a concern finishing. */
  degraded: StartupDegradation | null;
}

export function startupGateState(input: StartupGateInput): StartupGateState {
  if (input.hydrated && input.fontsSettled) {
    return { proceed: true, degraded: null };
  }
  if (!input.watchdogElapsed) return { proceed: false, degraded: null };
  // Auth outranks fonts: not knowing who the user is changes which screen they
  // get, while a missing typeface only changes how it looks.
  return { proceed: true, degraded: input.hydrated ? "fonts" : "auth" };
}

export interface StartupDegradationNotice {
  title: string;
  message: string;
}

/**
 * What the user is told when the watchdog fires. Both messages state the
 * consequence and rule out data loss — the failure mode we are recovering from
 * is indistinguishable, from the outside, from "the app forgot my account".
 */
export function startupDegradationNotice(
  degradation: StartupDegradation,
): StartupDegradationNotice {
  if (degradation === "auth") {
    return {
      title: "Couldn't read your saved sign-in",
      message:
        "This device didn't answer in time, so you may need to sign in again. Nothing was deleted.",
    };
  }
  return {
    title: "Showing the system font",
    message:
      "Moosewave's typefaces didn't load on this launch. Everything works — only the type looks different.",
  };
}

/** `mobile.app_opened` outcome, so a hung launch is visible in telemetry. */
export function startupOutcome(degradation: StartupDegradation | null): string {
  if (!degradation) return "success";
  return degradation === "auth" ? "degraded_auth" : "degraded_fonts";
}
