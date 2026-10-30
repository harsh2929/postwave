/**
 * Forgot-password — request a reset link.
 *
 * Backend always returns 202, even for unknown emails (no enumeration).
 * Before requesting email, the app stores a random reset state together with
 * the selected API origin. The signed v1 email link echoes that state; the
 * return screen resolves it before choosing a client, including for arbitrary
 * self-hosted HTTPS origins.
 */
import { router } from "expo-router";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { createAuthClient, redactAuthError } from "@/api/auth";
import { PasswordResetRequestForm } from "@/components/auth/PasswordResetRequestForm";
import { PasswordResetSent } from "@/components/auth/PasswordResetSent";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useResendCooldown } from "@/hooks/useResendCooldown";
import { announce } from "@/lib/a11y";
import { linkRequestErrorMessage, OFFLINE_COPY } from "@/lib/authErrorCopy";
import { haptics } from "@/lib/haptics";
import { mobileAuthLinkStart } from "@/lib/authLinkContract";
import {
  clearPendingPasswordResetState,
  createPendingPasswordResetState,
} from "@/lib/authLinkState";
import { DEFAULT_API_BASE_URL, validateApiBaseUrl } from "@/lib/config";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

/**
 * Lightweight client-side email sanity check. The backend remains the
 * source of truth (and still returns 202 either way); this only catches
 * obvious typos (missing @ / domain) before we spend a round-trip.
 *
 * Mirrors sign-in.tsx's `isLikelyEmail` so the auth screens validate an
 * address identically.
 */
function isLikelyEmail(value: string): boolean {
  const v = value.trim();
  if (v.length > 320 || /\s/.test(v)) return false;
  const at = v.indexOf("@");
  if (at <= 0 || at !== v.lastIndexOf("@")) return false;
  const domain = v.slice(at + 1);
  return domain.length >= 3 && domain.includes(".") && !domain.endsWith(".");
}

// Pop back to the previous screen when there's stack history (the usual
// push-from-sign-in case), and fall back to the email sign-in screen when
// this route was opened cold — via a deep link, a notification, dev Fast
// Refresh, or saved-state restoration — so the "Back" buttons are never
// dead and the user is never stranded. Matches the sibling auth screens
// (reset-confirm / totp / magic-return), which replace to sign-in directly.
function goBackToSignIn(): void {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace("/(auth)/sign-in");
  }
}

export default function ForgotPassword() {
  const { t } = useTheme();
  const online = useIsOnline();
  const [baseUrl, setBaseUrl] = useState(DEFAULT_API_BASE_URL);
  const [showApi, setShowApi] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  // Address captured at the moment of a successful send — the input may be
  // edited afterwards (e.g. for a resend), so the confirmation echoes this.
  const [sentTo, setSentTo] = useState("");
  const resend = useResendCooldown();

  function fail(message: string): void {
    haptics.error();
    setError(message);
    announce(message);
  }

  async function onSubmit() {
    if (busy) return;
    const trimmed = email.trim();
    if (resend.seconds > 0) return;
    if (!trimmed) {
      fail("Enter your email");
      return;
    }
    if (!isLikelyEmail(trimmed)) {
      fail("Enter a valid email address");
      return;
    }
    if (!online) {
      fail(OFFLINE_COPY);
      return;
    }
    setError("");
    setBusy(true);
    // try/finally so the button never sticks in its disabled/spinner state
    // if anything between here and the response throws — authRequest itself
    // resolves rather than rejects, but URL building / client construction
    // run synchronously before the await.
    try {
      // This origin is selected in local UI and stored beside the random
      // pending state. The email link is never allowed to replace it.
      const validBaseUrl = validateApiBaseUrl(baseUrl);
      if (!validBaseUrl.ok) {
        // Reveal the collapsed field the message is about — otherwise the
        // user reads "HTTP is only supported for localhost" with no URL
        // field anywhere on screen.
        setShowApi(true);
        fail(validBaseUrl.message);
        return;
      }
      const api = createAuthClient(validBaseUrl.url);
      const pending = await createPendingPasswordResetState({
        email: trimmed,
        baseUrl: api.baseUrl,
      });
      const res = await api.passwordResetStart(
        trimmed,
        mobileAuthLinkStart(pending.state),
      );
      if (res.error) {
        await clearPendingPasswordResetState().catch(() => undefined);
        if (res.error.status === 429) resend.start(res.error.retryAfterSeconds);
        fail(linkRequestErrorMessage(res.error));
        return;
      }
      resend.start();
      setSentTo(trimmed);
      setSent(true);
    } catch (err) {
      await clearPendingPasswordResetState().catch(() => undefined);
      fail(
        redactAuthError(
          err instanceof Error ? err.message : "Password reset failed",
        ),
      );
    } finally {
      setBusy(false);
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
            Reset your password
          </Text>

          {sent ? (
            <PasswordResetSent
              email={sentTo}
              error={error}
              busy={busy}
              resendSeconds={resend.seconds}
              onResend={() => void onSubmit()}
              onBack={goBackToSignIn}
            />
          ) : (
            <PasswordResetRequestForm
              baseUrl={baseUrl}
              email={email}
              error={error}
              busy={busy}
              online={online}
              showApi={showApi}
              resendSeconds={resend.seconds}
              onToggleApi={() => setShowApi((value) => !value)}
              onBaseUrlChange={(value) => {
                setBaseUrl(value);
                if (error) setError("");
              }}
              onEmailChange={(value) => {
                setEmail(value);
                if (error) setError("");
              }}
              onSubmit={() => void onSubmit()}
              onBack={goBackToSignIn}
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
