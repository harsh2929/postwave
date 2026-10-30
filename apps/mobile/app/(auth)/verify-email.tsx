/**
 * Address verification — the landing screen for the link in the
 * "confirm your email" message.
 *
 * Before this route existed the link was claimed by nobody: `/verify-email`
 * appeared in neither the AASA claim nor `authPathKind`, so iOS handed the URL
 * to Safari. A user who tapped it on their phone got a web page while the app's
 * Settings row kept insisting "Email verified: No" — and sign-up's own promise
 * ("we'll send a verification email; you can verify later from Settings") was
 * only half true.
 *
 * Two deliberate differences from the magic-link / reset screens:
 *
 *   1. NO signed envelope. `sendVerification` builds the link with
 *      `buildAuthPublicLink(publicBaseURL, "/verify-email", plain)`, i.e. a
 *      bare `?token=`. There is no local pending state to bind against, so
 *      there is nothing to check client-side; the server's one-shot
 *      `ConsumeToken` is the whole authority.
 *   2. It NEVER signs anyone in or out. The endpoint is public and only flips
 *      `email_verified`. A signed-in session is refreshed so the Settings row
 *      updates without a relaunch; a signed-out visitor is simply told it
 *      worked and sent to sign-in.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { verifyEmailToken } from "@/api/authSessions";
import { announce, liveRegionProps } from "@/lib/a11y";
import { linkRequestErrorMessage } from "@/lib/authErrorCopy";
import { DEFAULT_API_BASE_URL } from "@/lib/config";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

type VerifyState = "working" | "done" | "fail";

export default function VerifyEmail() {
  const { t } = useTheme();
  const params = useLocalSearchParams<{ token?: string }>();
  const token = typeof params.token === "string" ? params.token : "";
  const storedBaseUrl = useAuthStore((s) => s.baseUrl);
  const [state, setState] = useState<VerifyState>("working");
  const [error, setError] = useState("");
  // The screen must post exactly once. Expo Router re-runs effects on focus
  // changes, and the token is one-shot: a second POST would report
  // `invalid_token` for a verification that actually succeeded.
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    let cancelled = false;
    void (async () => {
      if (!token) {
        setError("That verification link is incomplete. Open the link from your email again.");
        setState("fail");
        return;
      }
      // The link is origin-agnostic (it points at whatever PublicBaseURL the
      // server was configured with), so verify against the workspace this
      // device is already connected to, falling back to the build default.
      const res = await verifyEmailToken(storedBaseUrl ?? DEFAULT_API_BASE_URL, token);
      if (cancelled) return;
      if (res.error) {
        haptics.error();
        const message =
          res.error.code === "invalid_token" || res.error.code === "wrong_purpose"
            ? "That verification link has expired or was already used. Request a new one from Settings."
            : linkRequestErrorMessage(res.error);
        setError(message);
        announce(message);
        setState("fail");
        return;
      }
      haptics.success();
      announce("Email verified.");
      setState("done");
      // Best-effort: refresh so the Settings row flips without a relaunch.
      // A signed-out visitor has no session to refresh, and a refresh failure
      // must never turn a successful verification into an error screen — so
      // this is wrapped, not merely `.catch`ed (the store throws synchronously
      // when there is no session at all).
      try {
        await useAuthStore.getState().refreshSessionFromServer();
      } catch {
        /* verification already committed server-side; nothing to recover */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storedBaseUrl, token]);

  function leave(): void {
    const authed = useAuthStore.getState().canEnterApp();
    router.replace(authed ? "/(tabs)/settings" : "/(auth)/sign-in");
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
        {state === "working" ? (
          <>
            <ActivityIndicator color={t.accent} />
            <Text
              {...typeCap("heading")}
              style={{
                color: t.fg,
                ...typeStyle("heading"),
                fontFamily: FONT.semibold,
                marginTop: 16,
              }}
            >
              Verifying your email…
            </Text>
          </>
        ) : (
          <>
            <Text
              accessibilityRole="header"
              {...typeCap("title")}
              style={{
                color: t.fg,
                ...typeStyle("title"),
                fontWeight: "700",
                fontFamily: FONT.display,
                letterSpacing: -0.3,
                marginBottom: 8,
                textAlign: "center",
              }}
            >
              {state === "done" ? "Email verified" : "Couldn't verify that link"}
            </Text>
            <Text
              {...(state === "fail" ? liveRegionProps() : {})}
              testID="verify-email-message"
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
                textAlign: "center",
              }}
            >
              {state === "done"
                ? "Password resets and security alerts will now reach this address."
                : error}
            </Text>
            <Pressable
              onPress={leave}
              accessibilityRole="button"
              accessibilityLabel="Continue"
              style={{
                marginTop: 20,
                paddingHorizontal: 18,
                paddingVertical: 12,
                borderRadius: 12,
                minHeight: 44,
                minWidth: 200,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: t.accent,
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
                Continue
              </Text>
            </Pressable>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}
