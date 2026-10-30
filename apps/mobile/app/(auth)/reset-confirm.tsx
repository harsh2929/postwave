/**
 * Password reset confirmation.
 *
 * Reached through the signed v1 reset envelope. A mobile link must match
 * origin-bound pending state in SecureStore before this screen constructs an
 * API client; a browser link is handed to the unclaimed web fallback route.
 */
import * as Linking from "expo-linking";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { createAuthClient } from "@/api/auth";
import { PasswordResetForm } from "@/components/auth/PasswordResetForm";
import { ResetLinkGate } from "@/components/auth/ResetLinkGate";
import { useIsOnline } from "@/hooks/useIsOnline";
import { announce } from "@/lib/a11y";
import {
  OFFLINE_COPY,
  passwordResetStateErrorMessage,
  resetConfirmErrorMessage,
} from "@/lib/authErrorCopy";
import {
  authLinkProofFromRouteParams,
  browserAuthFallbackUrl,
} from "@/lib/authLinkContract";
import { haptics } from "@/lib/haptics";
import {
  clearPendingPasswordResetState,
  resolvePendingPasswordResetState,
} from "@/lib/authLinkState";
import { FONT } from "@/lib/fonts";
import { unregisterPushThenSignOut } from "@/lib/push";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function ResetConfirm() {
  const { t } = useTheme();
  const online = useIsOnline();
  const params = useLocalSearchParams<{
    token?: string;
    state?: string;
    link_version?: string;
    link_flow?: string;
    link_audience?: string;
    link_signature?: string;
    browser_fallback?: string;
  }>();
  const signOut = useAuthStore((s) => s.signOut);

  const proof = useMemo(
    () =>
      authLinkProofFromRouteParams({
        token: params.token,
        state: params.state,
        link_version: params.link_version,
        link_flow: params.link_flow,
        link_audience: params.link_audience,
        link_signature: params.link_signature,
      }),
    [
      params.token,
      params.state,
      params.link_version,
      params.link_flow,
      params.link_audience,
      params.link_signature,
    ],
  );

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [resolvedBaseUrl, setResolvedBaseUrl] = useState<string | null>(null);
  const [linkState, setLinkState] = useState<
    "checking" | "ready" | "invalid" | "browser_fallback"
  >("checking");

  /**
   * One failure path for the whole screen. `accessibilityRole="alert"` does
   * not announce on iOS, so every message is spoken explicitly; the haptic is
   * the non-visual, non-auditory third channel.
   */
  function fail(message: string): void {
    haptics.error();
    setError(message);
    announce(message);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setResolvedBaseUrl(null);
      if (!proof || proof.flow !== "reset") {
        fail(
          "This reset link is incomplete or has an unsupported format. Request a new link.",
        );
        setLinkState("invalid");
        return;
      }
      if (proof.audience === "web") {
        setLinkState("browser_fallback");
        return;
      }
      const pending = await resolvePendingPasswordResetState({
        state: proof.state ?? "",
      });
      if (cancelled) return;
      if (!pending.ok) {
        fail(passwordResetStateErrorMessage(pending.reason));
        setLinkState("invalid");
        return;
      }
      setResolvedBaseUrl(pending.pending.baseUrl);
      setLinkState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [proof]);

  async function onSubmit() {
    if (busy) return;
    setError("");
    if (!proof || proof.flow !== "reset" || linkState !== "ready" || !resolvedBaseUrl) {
      fail("This reset link is not ready. Request a new link if the problem continues.");
      return;
    }
    if (password.length < 12) {
      fail("Password must be at least 12 characters");
      return;
    }
    if (password !== confirm) {
      fail("Passwords do not match");
      return;
    }
    if (!online) {
      fail(OFFLINE_COPY);
      return;
    }
    setBusy(true);
    const api = createAuthClient(resolvedBaseUrl);
    const res = await api.passwordResetConfirm(proof, password);
    if (res.error) {
      setBusy(false);
      // Never `redactAuthError(message)` alone here: the server sends an empty
      // message for invalid_token, which leaves authRequest's "HTTP 400"
      // placeholder as the whole user-facing string.
      fail(resetConfirmErrorMessage(res.error));
      return;
    }
    // The password change is already committed server-side; clearing local
    // auth state is best-effort cleanup. signOut() can reject if a SecureStore
    // / vault delete throws (store/auth.ts wipes are unguarded), so guard it in
    // try/finally — otherwise a failed local wipe leaves `busy` stuck spinning
    // and the success screen never renders despite a successful reset.
    try {
      await clearPendingPasswordResetState();
      await unregisterPushThenSignOut(signOut);
    } catch {
      /* local-wipe failure shouldn't block the success screen — the reset
         already succeeded; the next sign-in will overwrite stale local state */
    } finally {
      setBusy(false);
      setDone(true);
      haptics.success();
      announce("Your password has been reset.");
    }
  }

  async function continueInBrowser() {
    if (!proof || proof.flow !== "reset" || proof.audience !== "web") return;
    try {
      await Linking.openURL(browserAuthFallbackUrl(proof));
    } catch {
      fail(
        "The browser could not be opened. Copy this email link into your browser or request a new link there.",
      );
      setLinkState("invalid");
    }
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
            Choose a new password
          </Text>

          {linkState !== "ready" ? (
            <ResetLinkGate
              state={linkState}
              error={error}
              onContinueInBrowser={() => void continueInBrowser()}
              onRequestNew={() => router.replace("/(auth)/forgot-password")}
              onBack={() => router.replace("/(auth)/sign-in")}
            />
          ) : done ? (
            <>
              <Text
                {...typeCap("callout")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("callout"),
                  fontFamily: FONT.regular,
                }}
              >
                Your password has been reset. Sign in with the new password.
              </Text>
              <Pressable
                onPress={() => router.replace("/(auth)/sign-in")}
                accessibilityRole="button"
                accessibilityLabel="Continue to sign in"
                style={{
                  marginTop: 24,
                  paddingVertical: 12,
                  borderRadius: 12,
                  backgroundColor: t.accent,
                  alignItems: "center",
                  opacity: 1,
                }}
              >
                <Text
                  {...typeCap("callout")}
                  style={{
                    color: t.accentFg,
                    ...typeStyle("callout"),
                    fontWeight: "700",
                    fontFamily: FONT.bold,
                  }}
                >
                  Continue to sign in
                </Text>
              </Pressable>
            </>
          ) : (
            <PasswordResetForm
              password={password}
              confirm={confirm}
              busy={busy}
              error={error}
              online={online}
              onPasswordChange={(value) => {
                setPassword(value);
                if (error) setError("");
              }}
              onConfirmChange={(value) => {
                setConfirm(value);
                if (error) setError("");
              }}
              onSubmit={() => void onSubmit()}
              onBack={() => router.replace("/(auth)/sign-in")}
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
