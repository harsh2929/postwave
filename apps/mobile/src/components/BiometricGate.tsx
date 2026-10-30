/**
 * BiometricGate — wraps the authenticated app in a Face ID / Touch ID
 * lock.
 *
 * Behaviour:
 *
 *   - When the lock preference is OFF (or the device has NO credential at
 *     all — no biometric and no passcode), the gate is a pure pass-through:
 *     it renders {children} and does nothing else. No prompt, no overlay, no
 *     AppState listener side effects.
 *
 *   - When the lock preference is ON and the device can authenticate (Face
 *     ID / Touch ID OR a device passcode), the gate starts LOCKED. It renders
 *     a branded lock screen until the user passes the prompt. Protected
 *     children are unmounted while locked, so native accessibility services
 *     and automation cannot traverse or activate hidden workspace controls.
 *     Arming on passcode-capability
 *     (not biometric-specifically) means the lock can't fail open if the
 *     user later removes their enrolled face but keeps a passcode.
 *
 *   - It covers content immediately on both `inactive` and `background`, so
 *     iOS cannot capture workspace content for the app-switcher snapshot.
 *     A true background round-trip auto-prompts on return; transient
 *     inactive states caused by Face ID do not create a prompt loop.
 *
 * The first unlock prompt fires automatically on mount (once we know the
 * pref is on + biometrics available) so the user isn't left staring at a
 * dead lock screen wondering what to tap.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as ScreenCapture from "expo-screen-capture";
import {
  Alert,
  AppState,
  type AppStateStatus,
  Platform,
  View,
} from "react-native";

import { AppLockOverlay } from "@/components/auth/AppLockOverlay";
import { shouldRepromptOnForeground } from "@/lib/appLockGrace";
import {
  authenticate,
  canAuthenticate,
  getAppLockGraceSeconds,
  getBiometricLockEnabled,
  isBiometricAvailable,
  setBiometricLockEnabled,
  subscribeAppLockGrace,
  subscribeBiometricLockPreference,
} from "@/lib/biometric";
import { haptics } from "@/lib/haptics";
import { unregisterPushThenSignOut } from "@/lib/push";
import { useTheme } from "@/lib/theme";
import { revokeThisDeviceTrust } from "@/lib/trustedDeviceRevoke";
import { clearWidgetSnapshot } from "@/lib/widgetData";
import { useAuthStore } from "@/store/auth";

const UNLOCK_REASON = "Unlock Moosewave";
const SCREEN_CAPTURE_KEY = "postwave-app-lock";

export function BiometricGate({ children }: { children: React.ReactNode }) {
  const { t } = useTheme();
  const workspaceName = useAuthStore((s) => s.session?.workspaceName ?? "");
  const [signingOut, setSigningOut] = useState(false);

  // Whether the lock feature is active for this session: pref ON AND the
  // device can perform device-owner authentication.
  const [armed, setArmed] = useState(false);
  // Have we finished the initial pref/availability check? Until then we
  // render children plainly (no flash of a lock the user never enabled).
  const [resolved, setResolved] = useState(false);
  // Locked state — only meaningful while `armed`. Starts locked so an
  // armed session always demands auth before revealing content.
  const [locked, setLocked] = useState(true);
  // Whether a biometric specifically is enrolled — only affects the CTA copy
  // (passcode-only devices shouldn't read "Unlock with Face ID").
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  // In-flight guard so a re-render / repeated tap can't stack OS prompts.
  const promptingRef = useRef(false);
  const pendingUnlockSuccess = useRef(false);
  const wasBackgrounded = useRef(false);
  // When the app last left the foreground, and how long an unlock survives
  // that trip. Refs, not state: they are read inside the AppState listener,
  // which must not be re-subscribed every time either value changes.
  const backgroundedAt = useRef<number | null>(null);
  const graceSeconds = useRef(0);
  const [appState, setAppState] = useState<AppStateStatus>(
    AppState.currentState,
  );
  // Auto-prompt only on initial arm and a real background return. A biometric
  // prompt itself makes iOS `inactive`; treating every `active` as a new
  // prompt would immediately reopen Face ID after cancellation.
  const [shouldAutoPrompt, setShouldAutoPrompt] = useState(false);

  // Resolve initial state and react to committed Settings changes. We arm on
  // canAuthenticate() (biometric OR device
  // passcode) — NOT isBiometricAvailable() — so the lock can't fail open if
  // the user enabled it and later dropped their enrolled face while keeping a
  // passcode; authenticate() falls back to the passcode prompt. Only a device
  // with NO credential at all stays a pass-through (arming would hard-lock).
  // If anything fails, all three resolve to safe falses → pass-through.
  useEffect(() => {
    let cancelled = false;
    let revision = 0;
    const resolveArmState = async (
      enabledOverride?: boolean,
      alreadyVerified = false,
    ): Promise<void> => {
      const requestRevision = ++revision;
      const [enabled, canAuth, bio] = await Promise.all([
        enabledOverride ?? getBiometricLockEnabled(),
        canAuthenticate(),
        isBiometricAvailable(),
      ]);
      if (cancelled || requestRevision !== revision) return;
      const nextArmed = enabled && canAuth;
      if (nextArmed) {
        // Widgets render outside this gate. Revoke their explicit disclosure
        // marker whenever an existing or newly enabled app lock arms; the
        // short native TTL is the final fallback if App Group I/O is down.
        clearWidgetSnapshot();
      }
      setArmed(nextArmed);
      setLocked(nextArmed && !alreadyVerified);
      setShouldAutoPrompt(nextArmed && !alreadyVerified);
      setBiometricAvailable(bio);
      setResolved(true);
    };
    void resolveArmState();
    void getAppLockGraceSeconds().then((seconds) => {
      if (!cancelled) graceSeconds.current = seconds;
    });
    const unsubscribeGrace = subscribeAppLockGrace((seconds) => {
      graceSeconds.current = seconds;
    });
    const unsubscribe = subscribeBiometricLockPreference((enabled) => {
      // Enabling is emitted only after Settings has just completed a device
      // authentication challenge, so arm immediately without a duplicate
      // prompt. The next inactive/background transition locks as normal.
      void resolveArmState(enabled, enabled);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeGrace();
    };
  }, []);

  // Protect native screenshots/recordings and app-switcher previews for the
  // full time the app lock is armed. This closes the scheduling window before
  // React can replace the mounted navigation tree on an AppState transition.
  useEffect(() => {
    if (!armed) return;
    void ScreenCapture.preventScreenCaptureAsync(SCREEN_CAPTURE_KEY);
    if (Platform.OS === "ios") {
      void ScreenCapture.enableAppSwitcherProtectionAsync(1);
    }
    return () => {
      void ScreenCapture.allowScreenCaptureAsync(SCREEN_CAPTURE_KEY);
      if (Platform.OS === "ios") {
        void ScreenCapture.disableAppSwitcherProtectionAsync();
      }
    };
  }, [armed]);

  const runUnlock = useCallback(async () => {
    if (promptingRef.current || AppState.currentState !== "active") return;
    promptingRef.current = true;
    setShouldAutoPrompt(false);
    try {
      const ok = await authenticate(UNLOCK_REASON);
      if (ok) {
        haptics.tap();
        if (AppState.currentState === "active") {
          setLocked(false);
        } else {
          // Keep the privacy cover mounted until iOS reports the app active.
          pendingUnlockSuccess.current = true;
        }
      }
    } finally {
      promptingRef.current = false;
    }
  }, []);

  // Auto-prompt on first arm and after a genuine background round-trip.
  useEffect(() => {
    if (armed && locked && appState === "active" && shouldAutoPrompt) {
      void runUnlock();
    }
  }, [appState, armed, locked, runUnlock, shouldAutoPrompt]);

  // Cover immediately on inactive/background. This runs before iOS captures
  // the app-switcher thumbnail. A background latch survives the intermediate
  // `inactive` event on return and enables one new automatic prompt.
  useEffect(() => {
    if (!armed) return;
    const sub = AppState.addEventListener("change", (next) => {
      setAppState(next);
      if (next !== "active") {
        // The privacy cover is UNCONDITIONAL and is not what the grace period
        // governs: iOS captures the app-switcher thumbnail on `inactive`, so
        // content is hidden immediately, every time, at any grace setting.
        setLocked(true);
        setShouldAutoPrompt(false);
        if (next === "background") {
          wasBackgrounded.current = true;
          backgroundedAt.current = Date.now();
        }
        return;
      }
      if (pendingUnlockSuccess.current) {
        pendingUnlockSuccess.current = false;
        wasBackgrounded.current = false;
        setShouldAutoPrompt(false);
        setLocked(false);
      } else if (wasBackgrounded.current) {
        wasBackgrounded.current = false;
        // Only the RE-PROMPT is graced. Stepping out to an authenticator for a
        // 2FA code and straight back should not cost a second Face ID scan;
        // anything longer than the window the user chose still does.
        const reprompt = shouldRepromptOnForeground(
          backgroundedAt.current,
          Date.now(),
          graceSeconds.current,
        );
        if (!reprompt) {
          setLocked(false);
          setShouldAutoPrompt(false);
          return;
        }
        // If an OS auth sheet itself happened to trigger a background event,
        // let the in-flight result settle; never stack a second prompt.
        setShouldAutoPrompt(!promptingRef.current);
      }
    });
    return () => {
      sub.remove();
    };
  }, [armed]);

  function confirmSignOut(): void {
    if (signingOut) return;
    Alert.alert(
      "Sign out of Moosewave?",
      "You'll need your email and password to sign back in on this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => {
            setSigningOut(true);
            void (async () => {
              try {
                // This escape hatch turns the lock OFF, so the remembered-
                // device trust granted under it goes too (see
                // lib/trustedDeviceRevoke). Best-effort and before the
                // teardown: the revoke needs the session cookie, and a failure
                // must not strand anyone on this lock screen — so the outcome
                // is deliberately ignored.
                await revokeThisDeviceTrust(useAuthStore.getState().baseUrl);
                await unregisterPushThenSignOut(
                  useAuthStore.getState().signOut,
                );
                // Disarm the lock too: a device whose authenticator is wedged
                // must not be locked out again on the next launch.
                await setBiometricLockEnabled(false).catch(() => undefined);
              } finally {
                setSigningOut(false);
              }
            })();
          },
        },
      ],
    );
  }

  if (!resolved) {
    return (
      <View
        style={{ flex: 1, backgroundColor: t.bg }}
        accessibilityRole="progressbar"
        accessibilityLabel="Checking workspace lock"
      />
    );
  }

  // Pass-through while the feature is off or unavailable.
  if (!armed) {
    return <>{children}</>;
  }

  // Keep no protected React tree mounted while locked. The accessibility
  // flags are defense in depth for the wrapper during the commit that removes
  // it, particularly for TalkBack on Android.
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{ flex: 1 }}
        accessibilityElementsHidden={locked}
        importantForAccessibility={locked ? "no-hide-descendants" : "auto"}
      >
        {locked ? null : children}
      </View>
      {locked ? (
        <AppLockOverlay
          biometricAvailable={biometricAvailable}
          workspaceName={workspaceName}
          signingOut={signingOut}
          onUnlock={() => void runUnlock()}
          onSignOut={confirmSignOut}
        />
      ) : null}
    </View>
  );
}
