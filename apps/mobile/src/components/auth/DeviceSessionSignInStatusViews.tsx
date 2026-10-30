import { ActivityIndicator, Text, View } from "react-native";

import { AuthSubmitButton } from "@/components/auth/AuthSubmitButton";
import { TextLink } from "@/components/TextLink";
import type { MobileDeviceSignInState } from "@/hooks/useDeviceSessionSignIn";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function DeviceSessionProgressView({
  state,
  onCancel,
}: {
  state: Extract<
    MobileDeviceSignInState,
    { phase: "starting" | "cancelling" | "verifying" }
  >;
  onCancel: () => void;
}) {
  const { t } = useTheme();
  const verifying = state.phase === "verifying";
  return (
    <View
      accessibilityRole="progressbar"
      style={{ alignItems: "center", gap: 12, paddingVertical: 48 }}
    >
      <ActivityIndicator size="large" color={t.accent} />
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontFamily: FONT.semibold,
        }}
      >
        {state.phase === "starting"
          ? "Creating a secure code…"
          : state.phase === "cancelling"
            ? "Ending sign-in…"
            : "Approval received"}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          textAlign: "center",
        }}
      >
        {verifying
          ? state.connectionIssue
            ? "Connection interrupted. Moosewave is retrying session verification."
            : "Securing your phone session…"
          : state.phase === "cancelling"
            ? "Moosewave is clearing the partial request."
            : "The code will be valid for only a few minutes."}
      </Text>
      {verifying ? (
        <TextLink
          onPress={onCancel}
          textStyle={{ color: t.fgMuted, fontFamily: FONT.regular }}
        >
          Cancel and sign out
        </TextLink>
      ) : null}
    </View>
  );
}

export function DeviceSessionErrorView({
  state,
  onStart,
  onCancel,
}: {
  state: Extract<MobileDeviceSignInState, { phase: "error" }>;
  onStart: () => void;
  onCancel: () => void;
}) {
  const { t } = useTheme();
  return (
    <View accessibilityRole="alert" style={{ gap: 14 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontFamily: FONT.semibold,
        }}
      >
        {state.reason === "denied"
          ? "Sign-in denied"
          : state.reason === "expired"
            ? "Code expired"
            : "Device sign-in unavailable"}
      </Text>
      <Text
        {...typeCap("body")}
        style={{
          color: t.fgMuted,
          ...typeStyle("body"),
          fontFamily: FONT.regular,
        }}
      >
        {state.message}
      </Text>
      <AuthSubmitButton label="Get a new code" onPress={onStart} />
      <TextLink
        onPress={onCancel}
        style={{ alignSelf: "center" }}
        textStyle={{ color: t.fgMuted, fontFamily: FONT.regular }}
      >
        Use another sign-in method
      </TextLink>
    </View>
  );
}
