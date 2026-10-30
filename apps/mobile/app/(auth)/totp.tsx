/**
 * Per-session TOTP challenge.
 *
 * This route never infers policy from an empty challenge request. `/me`
 * decides whether the session needs enrollment, challenge, or no login gate.
 * The settings flow can also request operation-specific step-up before
 * changing an existing factor. The challenge endpoint only proves a code
 * (including one-shot recovery codes).
 */
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { createAuthClient } from "@/api/auth";
import { authInputStyle } from "@/components/auth/authInputStyle";
import { RememberDeviceOptIn } from "@/components/auth/RememberDeviceOptIn";
import { submitTotpChallenge } from "@/api/totpChallengeFlow";
import { DEFAULT_TRUST_DAYS, type TrustDurationDays } from "@/lib/trustedDeviceContract";
import {
  MfaCheckingView,
  MfaGateErrorView,
} from "@/components/auth/MfaGateStates";
import { challengeErrorMessage } from "@/lib/authErrorCopy";
import {
  mfaAuthErrorCode,
  mfaSessionErrorCode,
  trackMfaCompleted,
} from "@/lib/authFlowTelemetry";
import { announce } from "@/lib/a11y";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { TotpGateFooter } from "@/components/auth/TotpGateFooter";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";
import {
  LocalAuthPersistenceError,
  needsMfaSecurityStepUp,
  useAuthStore,
} from "@/store/auth";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

type GateState = "checking" | "challenge" | "error" | "cancelling";

export default function TotpGate() {
  const { t } = useTheme();
  const params = useLocalSearchParams<{ purpose?: string }>();
  const securitySettingsStepUp = params.purpose === "security_settings";
  const baseUrl = useAuthStore((state) => state.baseUrl);
  const refreshSession = useAuthStore(
    (state) => state.refreshSessionFromServer,
  );
  const cancelSession = useAuthStore((state) => state.cancelSession);
  const sessionEmail = useAuthStore((state) => state.session?.email ?? "");
  const sessionWorkspace = useAuthStore(
    (state) => state.session?.workspaceName ?? "",
  );
  const accountLine = [sessionEmail, sessionWorkspace]
    .filter(Boolean)
    .join(" · ");
  const [gateState, setGateState] = useState<GateState>("checking");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [challengeAccepted, setChallengeAccepted] = useState(false);
  // AUTH#48. Off by default: a control that weakens MFA is ticked, never
  // inherited. See RememberDeviceOptIn for when it is offered at all.
  const [trust, setTrust] = useState<{
    remember: boolean;
    days: TrustDurationDays;
  }>({ remember: false, days: DEFAULT_TRUST_DAYS });
  const [trustBlocked, setTrustBlocked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const codeRef = useRef<TextInput>(null);

  const routeFromCanonicalState = useCallback((): boolean => {
    const auth = useAuthStore.getState();
    const gate = auth.mfaGate();
    if (gate === "enrollment") {
      router.replace("/(auth)/mfa-enroll");
      return true;
    }
    if (securitySettingsStepUp && auth.session) {
      if (!auth.session.totpEnabled || auth.session.mfaSatisfied) {
        router.replace("/(tabs)/settings");
        return true;
      }
      return false;
    }
    if (gate === "none" && auth.canEnterApp()) {
      router.replace("/(tabs)/dashboard");
      return true;
    }
    return false;
  }, [securitySettingsStepUp]);

  useEffect(() => {
    let cancelled = false;
    setGateState("checking");
    setError("");
    void (async () => {
      if (!baseUrl) {
        trackMfaCompleted("failure", "session_expired");
        setError("Your sign-in session expired. Please sign in again.");
        setGateState("error");
        return;
      }
      try {
        await refreshSession();
      } catch (refreshError) {
        if (
          refreshError instanceof LocalAuthPersistenceError &&
          routeFromCanonicalState()
        ) {
          return;
        }
        if (cancelled) return;
        trackMfaCompleted("failure", mfaSessionErrorCode(refreshError));
        setError(
          refreshError instanceof Error
            ? refreshError.message
            : "Couldn't check your two-factor status.",
        );
        setGateState("error");
        return;
      }
      if (cancelled || routeFromCanonicalState()) return;
      const auth = useAuthStore.getState();
      if (
        auth.mfaGate() !== "challenge" &&
        !(
          securitySettingsStepUp &&
          needsMfaSecurityStepUp(auth.session)
        )
      ) {
        trackMfaCompleted("failure", "state_not_satisfied");
        setError("Couldn't confirm that a two-factor challenge is required.");
        setGateState("error");
        return;
      }
      setGateState("challenge");
    })();
    return () => {
      cancelled = true;
    };
  }, [
    attempt,
    baseUrl,
    refreshSession,
    routeFromCanonicalState,
    securitySettingsStepUp,
  ]);

  const canSubmit = useRecovery
    ? recovery.trim().length > 0
    : /^\d{6}$/.test(code);

  async function finishVerifiedSession() {
    setBusy(true);
    setError("");
    try {
      await useAuthStore.getState().refreshSessionFromServer();
    } catch (refreshError) {
      if (
        refreshError instanceof LocalAuthPersistenceError &&
        useAuthStore.getState().mfaGate() === "none" &&
        !(
          securitySettingsStepUp &&
          needsMfaSecurityStepUp(useAuthStore.getState().session)
        )
      ) {
        trackMfaCompleted("success", "local_persistence_pending");
        Alert.alert("Verified — device save pending", refreshError.message);
        if (!routeFromCanonicalState()) {
          router.replace("/(tabs)/dashboard");
        }
        return;
      }
      trackMfaCompleted("failure", mfaSessionErrorCode(refreshError));
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Verification succeeded, but the session could not be refreshed.",
      );
      setGateState("error");
      return;
    } finally {
      setBusy(false);
    }
    const auth = useAuthStore.getState();
    if (
      auth.mfaGate() === "none" &&
      auth.canEnterApp() &&
      !(
        securitySettingsStepUp && needsMfaSecurityStepUp(auth.session)
      )
    ) {
      trackMfaCompleted("success", "none");
      routeFromCanonicalState();
      return;
    }
    if (!routeFromCanonicalState()) {
      trackMfaCompleted("failure", "state_not_satisfied");
      setError(
        "The code was accepted, but the server has not marked this session verified yet. Try finishing sign-in again.",
      );
      setGateState("error");
    }
  }

  async function onSubmit(overrideCode?: string) {
    if (busy || !baseUrl) return;
    const normalizedCode = (overrideCode ?? code).replace(/\s+/g, "");
    if (useRecovery ? !recovery.trim() : !/^\d{6}$/.test(normalizedCode)) {
      trackMfaCompleted("failure", "invalid_code");
      setError(
        useRecovery
          ? "Enter a recovery code"
          : "Enter the 6-digit code from your authenticator",
      );
      return;
    }
    setBusy(true);
    setError("");
    const wantedTrust = trust.remember;
    // AUTH#48: the trust opt-in and its one safe retry live in the flow module.
    const attempted = await submitTotpChallenge(
      createAuthClient(baseUrl),
      useRecovery ? { recovery_code: recovery.trim() } : { code: normalizedCode },
      trust,
    );
    const result = attempted.result;
    if (attempted.trustRefused) {
      setTrustBlocked(true);
      setTrust((value) => ({ ...value, remember: false }));
    }
    setBusy(false);
    if (result.error) {
      trackMfaCompleted("failure", mfaAuthErrorCode(result.error));
      if (result.error.code === "not_enrolled") {
        await refreshSession().catch(() => undefined);
        if (routeFromCanonicalState()) return;
      }
      if (result.error.code === "no_session") {
        await cancelSession();
        setGateState("error");
      }
      const message = challengeErrorMessage(result.error, useRecovery);
      haptics.error();
      setError(message);
      announce(message);
      if (!useRecovery) {
        setCode("");
        codeRef.current?.focus();
      }
      return;
    }
    if (!result.data?.mfa_satisfied && !result.data?.already) {
      trackMfaCompleted("failure", "invalid_response");
      setError("The server did not confirm two-factor verification.");
      return;
    }
    // Report the SERVER's answer, not the request: issuance can fail on an
    // otherwise successful challenge, and silence would read as "remembered".
    if (wantedTrust && result.data?.device_trusted !== true) {
      announce("Verified, but this device was not remembered.");
    }
    // Never ask for the same recovery code again after a 200. It has already
    // been consumed even if the following /me request loses connectivity.
    setChallengeAccepted(true);
    haptics.success();
    await finishVerifiedSession();
  }

  async function switchAccount() {
    if (gateState === "cancelling") return;
    if (securitySettingsStepUp) {
      trackMfaCompleted("cancelled", "user_cancelled");
      router.replace("/(tabs)/settings");
      return;
    }
    setGateState("cancelling");
    trackMfaCompleted("cancelled", "user_cancelled");
    await cancelSession();
    router.replace("/(auth)/sign-in");
  }

  if (gateState === "checking" || gateState === "cancelling") {
    return <MfaCheckingView cancelling={gateState === "cancelling"} />;
  }

  if (gateState === "error") {
    return (
      <MfaGateErrorView
        error={error}
        busy={busy}
        primaryLabel={challengeAccepted ? "Finish sign-in" : "Try again"}
        secondaryLabel={securitySettingsStepUp ? "Cancel" : "Switch account"}
        onPrimary={() => {
          if (challengeAccepted) void finishVerifiedSession();
          else setAttempt((value) => value + 1);
        }}
        onSecondary={() => void switchAccount()}
      />
    );
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: t.bg }}
      edges={["top", "bottom"]}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            padding: 20,
            justifyContent: "center",
          }}
          keyboardShouldPersistTaps="handled"
        >
          <Text
            accessibilityRole="header"
            {...typeCap("display")}
            style={{
              color: t.fg,
              ...typeStyle("display"),
              fontWeight: "700",
              fontFamily: FONT.display,
              letterSpacing: -0.4,
              marginBottom: 8,
            }}
          >
            Two-factor verification
          </Text>
          {/* On a shared or multi-account phone a bare "enter the 6-digit
              code" gives no clue which authenticator entry to open. */}
          {accountLine ? (
            <Text
              numberOfLines={1}
              ellipsizeMode="middle"
              {...typeCap("callout")}
              style={{
                color: t.fg,
                ...typeStyle("callout"),
                fontFamily: FONT.semibold,
                marginBottom: 6,
              }}
            >
              {accountLine}
            </Text>
          ) : null}
          <Text
            {...typeCap("callout")}
            style={{
              color: t.fgMuted,
              ...typeStyle("callout"),
              marginBottom: 18,
              fontFamily: FONT.regular,
            }}
          >
            {useRecovery
              ? "Enter one of your one-time recovery codes."
              : "Enter the 6-digit code from your authenticator app."}
          </Text>

          {useRecovery ? (
            <TextInput
              // Inputs scale with the OS text size but their height does not — cap it.
              {...typeCap("body")}
              value={recovery}
              onChangeText={(value) => {
                setRecovery(value);
                setError("");
              }}
              placeholder="xxxx-xxxx-xxxx"
              placeholderTextColor={t.fgSubtle}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              maxLength={32}
              returnKeyType="go"
              onSubmitEditing={() => void onSubmit()}
              accessibilityLabel="Recovery code"
              style={authInputStyle(t)}
            />
          ) : (
            <TextInput
              ref={codeRef}
              value={code}
              onChangeText={(value) => {
                const digits = value.replace(/\D/g, "").slice(0, 6);
                setCode(digits);
                setError("");
                // `busy` guards the double-fire; a paste that lands all six at
                // once submits exactly one challenge.
                if (digits.length === 6 && !busy) void onSubmit(digits);
              }}
              placeholder="123456"
              placeholderTextColor={t.fgSubtle}
              keyboardType="number-pad"
              maxLength={6}
              returnKeyType="go"
              onSubmitEditing={() => void onSubmit()}
              autoFocus
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              accessibilityLabel="6-digit authentication code"
              {...typeCap("display")}
              style={[
                authInputStyle(t),
                {
                  letterSpacing: 6,
                  fontSize: fontSizeFor("display"),
                  textAlign: "center",
                },
              ]}
            />
          )}

          {/* Offered only on a phone whose app lock is on — see the component. */}
          <RememberDeviceOptIn
            remember={trust.remember}
            days={trust.days}
            onChange={setTrust}
            disabledByWorkspace={trustBlocked}
          />

          {error ? (
            <Text
              accessibilityRole="alert"
              {...typeCap("bodySmall")}
              style={{
                color: t.danger,
                ...typeStyle("bodySmall"),
                marginTop: 8,
                fontFamily: FONT.regular,
              }}
            >
              {error}
            </Text>
          ) : null}

          <Pressable
            onPress={() => void onSubmit()}
            disabled={busy || !canSubmit}
            accessibilityRole="button"
            accessibilityLabel="Verify code"
            accessibilityState={{ disabled: busy || !canSubmit, busy }}
            style={{
              marginTop: 16,
              paddingVertical: 14,
              borderRadius: 12,
              backgroundColor: t.accent,
              alignItems: "center",
              opacity: busy || !canSubmit ? 0.55 : 1,
            }}
          >
            {busy ? (
              <ActivityIndicator color={t.accentFg} />
            ) : (
              <Text
                {...typeCap("body")}
                style={{
                  color: t.accentFg,
                  fontWeight: "700",
                  ...typeStyle("body"),
                  fontFamily: FONT.bold,
                }}
              >
                Verify
              </Text>
            )}
          </Pressable>

          <TotpGateFooter
            useRecovery={useRecovery}
            busy={busy}
            securitySettingsStepUp={securitySettingsStepUp}
            onToggleRecovery={() => {
              setUseRecovery((value) => !value);
              setError("");
              setCode("");
              setRecovery("");
            }}
            onSwitchAccount={() => void switchAccount()}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
