/**
 * SignInFooterLinks — the three ways off the sign-in screen, plus the legal
 * row: forgot password, create an account, and the API-key fallback.
 *
 * Extracted from sign-in.tsx so the screen can stay inside its line budget
 * while the credential form grows per-field validation. Pure presentation; the
 * navigation targets are passed in so the screen keeps owning routing.
 */
import { View } from "react-native";

import { LegalLinks } from "@/components/LegalLinks";
import { TextLink } from "@/components/TextLink";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeStyle } from "@/lib/typeScale";

export function SignInFooterLinks({
  onForgotPassword,
  onCreateAccount,
  onUseAnotherDevice,
  onUseApiKey,
}: {
  onForgotPassword: () => void;
  onCreateAccount: () => void;
  onUseAnotherDevice: () => void;
  onUseApiKey: () => void;
}) {
  const { t } = useTheme();
  // TextLink supplies the Dynamic Type CEILING; these overrides supply only
  // the step, and take it from the scale rather than a literal.
  const linkStyle = {
    color: t.accent,
    ...typeStyle("bodySmall"),
    fontWeight: "600" as const,
    fontFamily: FONT.semibold,
  };
  return (
    <>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          marginTop: 16,
        }}
      >
        <TextLink onPress={onForgotPassword} textStyle={linkStyle}>
          Forgot password?
        </TextLink>
        <TextLink onPress={onCreateAccount} textStyle={linkStyle}>
          Create an account
        </TextLink>
      </View>

      <View
        style={{
          marginTop: 24,
          paddingTop: 16,
          borderTopWidth: 1,
          borderColor: t.borderSubtle,
          alignItems: "center",
          gap: 4,
        }}
      >
        <TextLink
          onPress={onUseAnotherDevice}
          textStyle={{
            color: t.accent,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
          }}
        >
          Sign in with another device
        </TextLink>
        <TextLink
          onPress={onUseApiKey}
          textStyle={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          I have an API key
        </TextLink>
      </View>

      <View style={{ marginTop: 18 }}>
        <LegalLinks />
      </View>
    </>
  );
}
