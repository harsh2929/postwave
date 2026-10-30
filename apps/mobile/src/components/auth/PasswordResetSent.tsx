/**
 * PasswordResetSent — the confirmation half of the forgot-password flow.
 *
 * Three fixes here, all shared with the magic-link confirmation:
 *   - The address was an inline `<Text numberOfLines={1}>` nested inside a
 *     parent Text run, where numberOfLines is a no-op. A long address wrapped
 *     and pushed the actions below the fold.
 *   - Resend had no cooldown, and /password-reset/start sits behind
 *     AuthBruteforceLimiter, so impatient tapping bought a 5-minute lockout.
 *   - There was no way to open Mail, which is the unambiguous next step.
 */
import { ActivityIndicator, Pressable, Text } from "react-native";

import { OpenMailButton } from "@/components/auth/OpenMailButton";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function PasswordResetSent({
  email,
  error,
  busy,
  resendSeconds = 0,
  onResend,
  onBack,
}: {
  email: string;
  error: string;
  busy: boolean;
  /** Seconds until Resend re-arms; 0 when it is available. */
  resendSeconds?: number | undefined;
  onResend: () => void;
  onBack: () => void;
}) {
  const { t } = useTheme();
  const coolingDown = resendSeconds > 0;
  const resendDisabled = busy || coolingDown;

  return (
    <>
      <Text
        numberOfLines={2}
        ellipsizeMode="middle"
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          marginBottom: 4,
        }}
      >
        {email || "your email"}
      </Text>
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fgMuted,
          ...typeStyle("callout"),
          fontFamily: FONT.regular,
        }}
      >
        If an account exists for that address, we sent a reset link. The link
        expires in 1 hour. Open it on this device to choose a new password.
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("bodySmall"),
          marginTop: 10,
          fontFamily: FONT.regular,
        }}
      >
        Don&apos;t see it? Check your spam folder, then resend.
      </Text>
      {error ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
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

      <OpenMailButton style={{ marginTop: 20 }} />

      <Pressable
        onPress={onResend}
        disabled={resendDisabled}
        accessibilityRole="button"
        accessibilityLabel={
          coolingDown
            ? `Resend available in ${resendSeconds} seconds`
            : "Resend reset link"
        }
        accessibilityState={{ disabled: resendDisabled, busy }}
        style={{
          marginTop: 10,
          paddingVertical: 14,
          borderRadius: 12,
          backgroundColor: t.accent,
          alignItems: "center",
          justifyContent: "center",
          minHeight: 44,
          opacity: resendDisabled ? 0.7 : 1,
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
              fontFamily: FONT.bold,
              ...typeStyle("body"),
            }}
          >
            {coolingDown ? `Resend in ${resendSeconds}s` : "Resend link"}
          </Text>
        )}
      </Pressable>
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back to sign in"
        style={{
          marginTop: 10,
          paddingVertical: 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          alignItems: "center",
          justifyContent: "center",
          minHeight: 44,
          backgroundColor: t.surface,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Back to sign in
        </Text>
      </Pressable>
    </>
  );
}
