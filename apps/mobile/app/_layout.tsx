/**
 * Root layout. Four jobs, and deliberately nothing else:
 *
 *   1. Kick off auth hydration and connectivity observation (useAppBootstrap).
 *   2. Decide when the app may paint, WITHOUT the possibility of waiting
 *      forever (useHydrationGate → lib/startupGate).
 *   3. Provide the app-wide context: theme, toast, confirm, query cache, tour.
 *   4. Mount the lifecycle concerns once, below those providers
 *      (ShellLifecycle).
 *
 * This file used to be a 617-line component holding nine independent
 * lifecycle effects and a 120-line notification-response handler with its own
 * retry protocol (SHELL#78 / NATIVE-V#3). Each concern now lives in its own
 * hook under src/hooks/, which is what made SHELL#62 (splash watchdog),
 * SHELL#71 (silently-ignored deep links) and SHELL#72 (stacked Alert dialogs
 * on the killed-app approve path) fixable and testable at all.
 *
 * Provider ORDER is load-bearing; see the comments on the tree below.
 */
import "../global.css";

import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";

import { useAppBootstrap } from "@/hooks/useAppBootstrap";
import { useHydrationGate } from "@/hooks/useHydrationGate";
import { installWidgetRefreshTask } from "@/hooks/useWidgetBackgroundRefresh";
import { useMotion } from "@/lib/motion";
import { registerOfflineMutationDefaults } from "@/lib/offlineMutations";
import { queryClient, queryPersistOptions } from "@/lib/queryClient";
import { configureQueryPersistenceScope } from "@/lib/secureQueryPersister";
import { initSentry, wrap as wrapWithSentry } from "@/lib/sentry";
import { getOptOut as getTelemetryOptOut } from "@/lib/telemetry";
import type { StartupDegradation } from "@/lib/startupGate";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { useAuthStore } from "@/store/auth";
import { BiometricGate } from "@/components/BiometricGate";
import { StepUpPrompt } from "@/components/StepUpPrompt";
import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ShellLifecycle } from "@/components/ShellLifecycle";
import { StartupDegradedNotice } from "@/components/StartupDegradedNotice";
import { ToastProvider } from "@/components/Toast";
import { UpgradeRequiredGate } from "@/components/UpgradeRequiredScreen";
import { OfflineBanner } from "@/components/OfflineBanner";
import { OfflineMutationFailureBanner } from "@/components/OfflineMutationFailureBanner";
import { BrandedSplash } from "@/components/onboarding/BrandedSplash";
import { TourProvider } from "@/components/tour/TourProvider";

// Root error boundary — Expo Router renders this if any screen throws,
// instead of dropping the user to a blank screen. (See AppErrorBoundary.)
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

// Sentry first — wired at module load so any error during
// SplashScreen.preventAutoHideAsync() / hydration is captured. No-op
// when EXPO_PUBLIC_SENTRY_DSN_MOBILE is unset. The native Sentry SDK
// hooks the JS error globals at init(); the default export is also wrapped so
// React render failures and native touch context are connected to the same
// release. Keep this init before any layout side effects.
// Consent is read before the SDK starts, so `initSentry` is async and this is
// deliberately not awaited: the module graph must keep evaluating. The reader
// is injected because lib/sentry must not import expo-secure-store.
void initSentry(getTelemetryOptOut);

// Register default mutationFns for offline-safe mutations BEFORE the
// persister restores and calls resumePausedMutations() — otherwise a
// rehydrated (queued-offline) mutation has no fn and is silently dropped.
registerOfflineMutationDefaults(queryClient);

// Define the home-screen widget's BGAppRefreshTask here, for the same reason
// the two calls above are here: a background wake runs the bundle and then
// asks TaskManager for the handler. Both halves used to sit in effects inside
// useWidgetBackgroundRefresh, which ShellLifecycle mounts BELOW the launch
// gate's `if (!proceed) return null` — so a wake found either no task or one
// with no work installed, which the handler reports as Failed and the OS
// answers by shrinking our future scheduling budget. Defining reaches no
// network and discloses nothing: the task re-checks consent and identity on
// every run, and SCHEDULING still happens from the hook, which needs an
// authenticated identity. Idempotent, so a background launch re-running module
// scope is safe.
installWidgetRefreshTask();

// Keep the splash visible until we've decided where to send the user. The
// matching hideAsync() lives in useHydrationGate, which is also what
// guarantees the splash cannot outlive a fault.
void SplashScreen.preventAutoHideAsync();

function RootLayout() {
  useAppBootstrap();
  const { hydrated, proceed, degraded } = useHydrationGate();
  const canEnterApp = useAuthStore((s) => s.canEnterApp());
  const authMode = useAuthStore((s) => s.mode);
  const authBaseUrl = useAuthStore((s) => s.baseUrl);
  const authSession = useAuthStore((s) => s.session);

  // The encrypted persister resolves its identity lazily when the provider
  // mounts. API-key mode intentionally has no disk-backed offline queue: it
  // has no human user/role identity with which to isolate shared-device data.
  const persistenceScope = configureQueryPersistenceScope(
    authMode === "session" && authBaseUrl && authSession
      ? {
          baseUrl: authBaseUrl,
          tenantId: authSession.tenantId,
          principalId: authSession.userId,
          role: authSession.effectiveRole,
        }
      : null,
  );

  // Don't paint until the launch gate says so. Unlike the old `!ready` check,
  // this cannot wait forever: the watchdog proceeds in a stated degraded state
  // rather than leaving the user on the splash screen with no way out.
  if (!proceed) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {/* Theme, Toast and Confirm sit ABOVE PersistQueryClientProvider on
            purpose. That provider is KEYED on the persistence scope, so it
            remounts on every auth transition; anything below it loses its
            state at exactly the moment a deferred deep link or a cold-start
            notification is being flushed. None of these three needs the query
            cache, so hoisting them costs nothing and makes the shell's
            one-shot guards survive sign-in. */}
        <ThemeProvider>
          {/* ToastProvider is outermost of the two because a confirmation
              that resolves into a "Deleted · Undo" toast must be able to show
              that toast after its own sheet has unmounted. */}
          <ToastProvider>
            <ConfirmProvider>
              <PersistQueryClientProvider
                key={persistenceScope ?? "offline-persistence-disabled"}
                client={queryClient}
                persistOptions={queryPersistOptions}
                onSuccess={() => {
                  if (useAuthStore.getState().canUseOnlineServices()) {
                    void queryClient.resumePausedMutations();
                  }
                }}
              >
                {/* TourProvider wraps the whole stack so it can register
                    target refs across any tab. Auto-launch is gated on auth —
                    unauth users never see the tour. Replay lives in the More
                    menu ("Replay product tour"), not a floating FAB: a global
                    FAB sat on top of every screen's scroll content. */}
                <TourProvider ready={hydrated && canEnterApp}>
                  {/* Biometric workspace lock — only gate authenticated
                      content so the lock never sits in front of the sign-in
                      screens (a user who can't pass Face ID must still be able
                      to reach auth). Once authed the gate enforces the
                      "Require Face ID to unlock" preference (pass-through when
                      the pref is off or biometrics are unavailable). */}
                  {canEnterApp ? (
                    <BiometricGate>
                      <ThemedStack degraded={degraded} />
                    </BiometricGate>
                  ) : (
                    <ThemedStack degraded={degraded} />
                  )}
                </TourProvider>
              </PersistQueryClientProvider>
              {/* The sheet a step-up challenge raises instead of a sign-out.
                  ABOVE PersistQueryClientProvider for the same reason Theme /
                  Toast / Confirm are: that provider is keyed on the persistence
                  scope and remounts on auth transitions, and a prompt that
                  unmounts mid-challenge answers "no" — which would cancel the
                  very action the user was confirming. It renders null until a
                  challenge arrives, and the transport abandons any challenge
                  nobody claims, so being mounted is what makes the feature
                  exist at all. */}
              <StepUpPrompt />
              {/* LAST child on purpose: React runs child effects before parent
                  effects, so mounting the lifecycle here preserves the old
                  ordering in which deep-link / notification routing ran after
                  the navigator subtree had mounted. It renders nothing. */}
              <ShellLifecycle />
            </ConfirmProvider>
          </ToastProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default wrapWithSentry(RootLayout);

// Guards the one-time branded launch overlay. Module-scoped (not component
// state or a ref) so it survives a ThemedStack REMOUNT: an in-session auth
// transition swaps the PersistQueryClientProvider key (persistence scope
// null↔concrete) and the BiometricGate conditional, either of which remounts
// ThemedStack and would otherwise reset a per-instance flag — replaying the
// splash over the dashboard after sign-in / over sign-in after logout. It must
// play exactly once per process launch.
let brandedSplashPlayed = false;

/**
 * ThemedStack pulls colors from the active theme so the status bar
 * style + the root Stack's content background flip with the user's
 * theme preference. Lives inside <ThemeProvider> so useTheme() works.
 */
function ThemedStack({ degraded }: { degraded: StartupDegradation | null }) {
  const { t, theme } = useTheme();
  // Screen transitions are motion like any other. A cross-fade between full
  // screens is exactly the kind of movement Reduce Motion exists to remove,
  // and every other animation in the app already honours it via lib/motion.
  const { reduceMotion } = useMotion();
  // Branded launch overlay — painted over the dismissing native splash on
  // cold start so the hand-off reads as one continuous brand moment, then
  // fades itself out (instant for reduced-motion users). Gated on the
  // module-level `brandedSplashPlayed` so it shows only on the first mount of
  // the process, not on every remount from an auth transition.
  const [showBrandedSplash, setShowBrandedSplash] = useState(
    () => !brandedSplashPlayed,
  );
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <StatusBar style={theme === "light" ? "dark" : "light"} />
      {/* Why the launch notice is FIRST: when it renders at all, the app got
          here by timing out, and the user's model is "something is wrong with
          my account". That has to be answered above everything else. */}
      <StartupDegradedNotice reason={degraded} />
      {/* App-wide offline notice. Self-hides when online (returns null),
          so it adds no chrome on the happy path. */}
      <OfflineBanner />
      <OfflineMutationFailureBanner />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: t.bg },
          animation: reduceMotion ? "none" : "fade",
        }}
      />
      {showBrandedSplash ? (
        <BrandedSplash
          onDone={() => {
            brandedSplashPlayed = true;
            setShowBrandedSplash(false);
          }}
        />
      ) : null}
      {/* Blocking upgrade screen for an HTTP 426 from the gateway. Renders
          null until the server tells this build it is below the supported
          floor, so it costs nothing in the normal case — but it must be the
          LAST child so it overlays the navigator when it does fire. */}
      <UpgradeRequiredGate />
    </View>
  );
}
