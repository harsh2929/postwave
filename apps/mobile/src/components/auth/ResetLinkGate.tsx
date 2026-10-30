import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export type ResetLinkGateState = "checking" | "invalid" | "browser_fallback";

export function ResetLinkGate({
  state,
  error,
  onContinueInBrowser,
  onRequestNew,
  onBack,
}: {
  state: ResetLinkGateState;
  error: string;
  onContinueInBrowser: () => void;
  onRequestNew: () => void;
  onBack: () => void;
}) {
  const { t } = useTheme();
  if (state === "checking") {
    return (
      <View style={{ alignItems: "center", paddingVertical: 24 }}>
        <ActivityIndicator color={t.accent} />
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fgMuted,
            ...typeStyle("callout"),
            marginTop: 12,
            fontFamily: FONT.regular,
          }}
        >
          Verifying this reset link…
        </Text>
      </View>
    );
  }
  const browser = state === "browser_fallback";
  return (
    <>
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fgMuted,
          ...typeStyle("callout"),
          fontFamily: FONT.regular,
        }}
      >
        {browser
          ? "This reset was requested on the web. For your security, the app won’t consume a browser link against a locally selected account server."
          : error || "This reset link is missing or invalid. Request a new one to continue."}
      </Text>
      <Pressable
        onPress={browser ? onContinueInBrowser : onRequestNew}
        accessibilityRole="button"
        accessibilityLabel={browser ? "Continue password reset in browser" : "Request a new reset link"}
        style={{
          marginTop: 24,
          paddingVertical: 12,
          borderRadius: 12,
          backgroundColor: t.accent,
          alignItems: "center",
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
          {browser ? "Continue in browser" : "Request a new link"}
        </Text>
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
          Back
        </Text>
      </Pressable>
    </>
  );
}
