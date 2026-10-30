/**
 * MagicSentView — the "check your email" state of the magic-link flow.
 *
 * Extracted from the 830-line sign-in screen, and fixed on the way out:
 *
 *  - The address was an inline `<Text numberOfLines={1}>` nested inside a
 *    parent `<Text>` run. React Native applies numberOfLines only at the
 *    OUTERMOST Text of a run, so the prop was a no-op and a long address
 *    (up to 320 chars) wrapped and pushed Resend below the fold. It is now a
 *    standalone sibling with middle ellipsis.
 *  - The branch rendered a bare centred View with no ScrollView, so once the
 *    content overflowed there was no way to reach the actions at all.
 *  - Resend had no cooldown, and both start endpoints sit behind
 *    AuthBruteforceLimiter — tapping three times in ten seconds bought a
 *    five-minute lockout with no explanation.
 *  - There was no way to open Mail, which is unambiguously the next action.
 */
import { useRef } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { OpenMailButton } from "@/components/auth/OpenMailButton";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function MagicSentView({
  email,
  error,
  busy,
  resendSeconds,
  onResend,
  onUseAnotherMethod,
  headingRef,
}: {
  email: string;
  error: string;
  busy: boolean;
  /** Seconds until Resend re-arms; 0 when it is available. */
  resendSeconds: number;
  onResend: () => void;
  onUseAnotherMethod: () => void;
  headingRef?: React.Ref<Text> | undefined;
}) {
  const { t } = useTheme();
  const fallbackRef = useRef<Text>(null);
  const coolingDown = resendSeconds > 0;
  const resendDisabled = busy || coolingDown;
  const resendLabelText = coolingDown
    ? `Resend available in ${resendSeconds} seconds`
    : "Resend magic link";

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: t.bg }}
      edges={["top", "bottom"]}
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
          ref={headingRef ?? fallbackRef}
          accessibilityRole="header"
          {...typeCap("title")}
          style={{
            color: t.fg,
            ...typeStyle("title"),
            fontWeight: "600",
            fontFamily: FONT.display,
            marginBottom: 8,
          }}
        >
          Check your email
        </Text>
        {/* Standalone sibling, not an inline child: numberOfLines only binds
            at the outermost Text of a run. */}
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
          If an account exists for that address, we sent a sign-in link. It
          expires in 5 minutes. Tap the link from this device to finish signing
          in — and check your spam folder if it hasn&apos;t arrived.
        </Text>
        {error ? (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.danger,
              ...typeStyle("bodySmall"),
              marginTop: 12,
              fontFamily: FONT.regular,
            }}
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            testID="signin-error"
          >
            {error}
          </Text>
        ) : null}

        <OpenMailButton style={{ marginTop: 20 }} />

        <Pressable
          onPress={onResend}
          disabled={resendDisabled}
          accessibilityRole="button"
          accessibilityLabel={resendLabelText}
          accessibilityState={{ disabled: resendDisabled, busy }}
          testID="signin-resend"
          style={{
            marginTop: 10,
            paddingVertical: 14,
            borderRadius: 12,
            backgroundColor: t.accent,
            alignItems: "center",
            justifyContent: "center",
            minHeight: 44,
            opacity: resendDisabled ? 0.6 : 1,
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
          onPress={onUseAnotherMethod}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Use a different sign-in method"
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
            Use a different method
          </Text>
        </Pressable>
        <View style={{ height: 8 }} />
      </ScrollView>
    </SafeAreaView>
  );
}
