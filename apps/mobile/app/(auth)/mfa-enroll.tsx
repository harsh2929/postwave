/**
 * Mandatory TOTP enrollment for sessions covered by tenant MFA policy.
 *
 * `/me` decides whether this route is needed. Enrollment creates a factor;
 * verification proves the factor and satisfies the current session. Leaving
 * this route is a real account switch: the cookie session is revoked and all
 * local auth artifacts are cleared before sign-in is shown again.
 */
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { createAuthClient } from "@/api/auth";
import {
  type TotpEnrollData,
  TotpEnrollSheet,
} from "@/components/TotpEnrollSheet";
import { announce, liveRegionProps } from "@/lib/a11y";
// One copy module for the whole cluster. This screen used to carry its own
// `enrollmentErrorMessage` — same name, different behaviour: it ignored
// `Retry-After` entirely and fell through to `redactAuthError(error.message)`,
// which renders authRequest's literal "HTTP 500" placeholder when the server
// sends an empty message. Two implementations of one string is how copy drifts.
import { enrollmentErrorMessage } from "@/lib/authErrorCopy";
import {
  mfaAuthErrorCode,
  mfaSessionErrorCode,
  trackMfaCompleted,
} from "@/lib/authFlowTelemetry";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  AuthSessionStateError,
  LocalAuthPersistenceError,
  useAuthStore,
} from "@/store/auth";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

type EnrollmentState = "checking" | "ready" | "error" | "cancelling";

export default function MfaEnroll() {
  const { t } = useTheme();
  const baseUrl = useAuthStore((state) => state.baseUrl);
  const refreshSession = useAuthStore(
    (state) => state.refreshSessionFromServer,
  );
  const cancelSession = useAuthStore((state) => state.cancelSession);
  const [state, setState] = useState<EnrollmentState>("checking");
  const [data, setData] = useState<TotpEnrollData | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  /**
   * Enrollment is mandatory here — the user cannot reach the app until it
   * completes — so a silent failure is a dead end. `accessibilityRole="alert"`
   * announces on Android only, so speak it explicitly and buzz.
   */
  function fail(message: string): void {
    haptics.error();
    setError(message);
    announce(message);
    setState("error");
  }

  const routeFromCanonicalState = useCallback((): boolean => {
    const auth = useAuthStore.getState();
    const gate = auth.mfaGate();
    if (gate === "challenge") {
      router.replace("/(auth)/totp");
      return true;
    }
    if (gate === "none" && auth.canEnterApp()) {
      router.replace("/(tabs)/dashboard");
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState("checking");
    setError("");
    setData(null);
    void (async () => {
      if (!baseUrl) {
        trackMfaCompleted("failure", "session_expired");
        fail("Your sign-in session is no longer available.");
        return;
      }
      try {
        await refreshSession();
      } catch (refreshError) {
        // The in-memory state is already the canonical /me result when only
        // its journal write failed. Enrollment may continue safely; the
        // journal/cleanup marker prevents stale restoration after restart.
        if (!(refreshError instanceof LocalAuthPersistenceError)) {
          if (cancelled) return;
          trackMfaCompleted(
            "failure",
            mfaSessionErrorCode(refreshError),
          );
          fail(
            refreshError instanceof Error
              ? refreshError.message
              : "Couldn't check your two-factor status.",
          );
          return;
        }
      }
      if (cancelled || routeFromCanonicalState()) return;
      const auth = useAuthStore.getState();
      if (auth.mfaGate() !== "enrollment" || !auth.baseUrl) {
        trackMfaCompleted("failure", "state_not_satisfied");
        fail("Couldn't confirm that two-factor setup is required.");
        return;
      }
      const result = await createAuthClient(auth.baseUrl).totpEnroll();
      if (cancelled) return;
      if (result.error || !result.data) {
        // A confirmed factor may have appeared between /me and enroll (for
        // example, another device completed setup). Re-read /me and route to
        // challenge instead of leaving the user in an enrollment loop.
        if (result.error?.code === "mfa_required") {
          await refreshSession().catch(() => undefined);
          if (routeFromCanonicalState()) return;
        }
        trackMfaCompleted(
          "failure",
          result.error ? mfaAuthErrorCode(result.error) : "invalid_response",
        );
        fail(
          result.error
            ? enrollmentErrorMessage(result.error)
            : "The server didn't return enrollment details.",
        );
        return;
      }
      if (
        typeof result.data.otpauth_uri !== "string" ||
        !Array.isArray(result.data.recovery_codes) ||
        result.data.recovery_codes.some((code) => typeof code !== "string")
      ) {
        trackMfaCompleted("failure", "invalid_response");
        fail("The server returned invalid enrollment details. Try again.");
        return;
      }
      setData(result.data);
      setState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, baseUrl, refreshSession, routeFromCanonicalState]);

  async function verify(code: string) {
    const auth = useAuthStore.getState();
    if (!auth.baseUrl) {
      trackMfaCompleted("failure", "session_expired");
      return { ok: false, message: "Your sign-in session expired." };
    }
    const result = await createAuthClient(auth.baseUrl).totpVerify(code);
    if (result.error || !result.data?.verified) {
      trackMfaCompleted(
        "failure",
        result.error ? mfaAuthErrorCode(result.error) : "invalid_response",
      );
      if (result.error?.code === "invalid_code") {
        return {
          ok: false,
          message:
            "That code didn't work. Codes rotate every 30 seconds — enter the current one.",
        };
      }
      return {
        ok: false,
        message: result.error
          ? enrollmentErrorMessage(result.error)
          : "The server did not confirm verification.",
      };
    }
    try {
      const profile = await auth.refreshSessionFromServer();
      if (!profile.mfaSatisfied || useAuthStore.getState().mfaGate() !== "none") {
        trackMfaCompleted("failure", "state_not_satisfied");
        return {
          ok: false,
          message:
            "The code was accepted, but the session is not marked verified yet. Try again.",
        };
      }
    } catch (refreshError) {
      if (
        refreshError instanceof LocalAuthPersistenceError &&
        useAuthStore.getState().mfaGate() === "none"
      ) {
        trackMfaCompleted("success", "local_persistence_pending");
        return { ok: true, message: refreshError.message };
      }
      trackMfaCompleted("failure", mfaSessionErrorCode(refreshError));
      return {
        ok: false,
        message:
          refreshError instanceof Error
            ? refreshError.message
            : "The code was accepted, but the session could not be refreshed.",
      };
    }
    trackMfaCompleted("success", "none");
    return { ok: true };
  }

  async function switchAccount() {
    if (state === "cancelling") return;
    setState("cancelling");
    setData(null);
    trackMfaCompleted("cancelled", "user_cancelled");
    await cancelSession();
    router.replace("/(auth)/sign-in");
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: t.bg }}
      edges={["top", "bottom"]}
    >
      <View
        style={{
          flex: 1,
          padding: 20,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {state === "checking" || state === "cancelling" ? (
          <>
            <ActivityIndicator color={t.accent} />
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                marginTop: 12,
                fontFamily: FONT.regular,
              }}
            >
              {state === "cancelling"
                ? "Switching accounts…"
                : "Preparing secure two-factor setup…"}
            </Text>
          </>
        ) : state === "error" ? (
          <>
            <Text
              accessibilityRole="header"
              {...typeCap("title")}
              style={{
                color: t.fg,
                ...typeStyle("title"),
                fontWeight: "700",
                fontFamily: FONT.display,
                marginBottom: 8,
              }}
            >
              Two-factor setup couldn&apos;t continue
            </Text>
            <Text
              {...liveRegionProps()}
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                textAlign: "center",
                fontFamily: FONT.regular,
              }}
            >
              {error}
            </Text>
            <Pressable
              onPress={() => setAttempt((value) => value + 1)}
              accessibilityRole="button"
              accessibilityLabel="Retry two-factor setup"
              style={{
                marginTop: 18,
                paddingHorizontal: 18,
                paddingVertical: 12,
                borderRadius: 12,
                backgroundColor: t.accent,
              }}
            >
              <Text
                {...typeCap("callout")}
                style={{
                  color: t.accentFg,
                  ...typeStyle("callout"),
                  fontFamily: FONT.bold,
                  fontWeight: "700",
                }}
              >
                Try again
              </Text>
            </Pressable>
            <Pressable
              onPress={() => void switchAccount()}
              accessibilityRole="button"
              accessibilityLabel="Switch account"
              style={{ marginTop: 14, padding: 8 }}
            >
              <Text
                {...typeCap("callout")}
                style={{
                  color: t.accent,
                  ...typeStyle("callout"),
                  fontFamily: FONT.semibold,
                  fontWeight: "600",
                }}
              >
                Switch account
              </Text>
            </Pressable>
          </>
        ) : null}
      </View>
      <TotpEnrollSheet
        visible={state === "ready"}
        enrollData={data}
        closeLabel="Switch account"
        onClose={() => void switchAccount()}
        onVerify={verify}
        onVerified={() => router.replace("/(tabs)/dashboard")}
      />
    </SafeAreaView>
  );
}

export function isExpiredMfaSessionError(error: unknown): boolean {
  return (
    error instanceof AuthSessionStateError && error.code === "session_expired"
  );
}
