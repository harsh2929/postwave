/**
 * EmailVerificationRow — turns "Email verified: No" from a status readout into
 * a one-tap fix.
 *
 * Settings rendered `<Row label="Email verified" value="No" />` and stopped
 * there, while `POST /api/v1/auth/send-verification` has been mounted in the
 * authenticated group the whole time and sign-up literally promises "you can
 * verify later from Settings". The screen told the user something was wrong
 * and then gave them nowhere to go.
 *
 * Renders nothing at all once the address is verified, so the settings screen
 * does not carry a permanent row about a solved problem.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { sendVerificationEmail } from "@/api/authSessions";
import { useToast } from "@/components/Toast";
import { useResendCooldown } from "@/hooks/useResendCooldown";
import { announce } from "@/lib/a11y";
import { linkRequestErrorMessage } from "@/lib/authErrorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/** Long enough that impatient tapping cannot reach the server's own limiter. */
const RESEND_COOLDOWN_SECONDS = 60;

export function EmailVerificationRow() {
  const { t } = useTheme();
  const { toast } = useToast();
  const baseUrl = useAuthStore((s) => s.baseUrl);
  const mode = useAuthStore((s) => s.mode);
  const emailVerified = useAuthStore((s) => s.session?.emailVerified ?? true);
  const cooldown = useResendCooldown();
  const [busy, setBusy] = useState(false);

  if (mode !== "session" || emailVerified || !baseUrl) return null;

  const disabled = busy || cooldown.seconds > 0;

  async function send(): Promise<void> {
    if (disabled || !baseUrl) return;
    setBusy(true);
    try {
      const res = await sendVerificationEmail(baseUrl);
      if (res.error) {
        haptics.error();
        const message = linkRequestErrorMessage(res.error);
        toast({ kind: "error", message });
        announce(message);
        if (res.error.status === 429) {
          cooldown.start(res.error.retryAfterSeconds ?? RESEND_COOLDOWN_SECONDS);
        }
        return;
      }
      haptics.success();
      cooldown.start(RESEND_COOLDOWN_SECONDS);
      const message = "Verification email sent. Check your inbox and spam.";
      toast({ kind: "success", message });
      announce(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ marginTop: 8, gap: 6 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        Your email address hasn&apos;t been confirmed yet. Verifying it keeps
        password resets and security alerts reaching you.
      </Text>
      <Pressable
        onPress={() => void send()}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={
          cooldown.seconds > 0
            ? `Resend verification email, available in ${cooldown.seconds} seconds`
            : "Resend verification email"
        }
        accessibilityState={{ disabled, busy }}
        style={{
          paddingVertical: 10,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.accent,
          alignItems: "center",
          justifyContent: "center",
          minHeight: 44,
          opacity: disabled ? 0.55 : 1,
        }}
      >
        {busy ? (
          <ActivityIndicator color={t.accent} />
        ) : (
          <Text
            {...typeCap("callout")}
            style={{
              color: t.accent,
              ...typeStyle("callout"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {cooldown.seconds > 0
              ? `Resend in ${cooldown.seconds}s`
              : "Resend verification email"}
          </Text>
        )}
      </Pressable>
    </View>
  );
}
