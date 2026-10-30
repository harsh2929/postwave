import { router } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";

import { createAuthClient } from "@/api/auth";
import {
  type TotpEnrollData,
  TotpEnrollSheet,
} from "@/components/TotpEnrollSheet";
import {
  Card,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export function TotpSecuritySection() {
  const { t } = useTheme();
  const baseUrl = useAuthStore((s) => s.baseUrl);
  const mode = useAuthStore((s) => s.mode);
  const session = useAuthStore((s) => s.session);
  const refreshSession = useAuthStore((s) => s.refreshSessionFromServer);
  const [totpBusy, setTotpBusy] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollData, setEnrollData] = useState<TotpEnrollData | null>(null);
  // The button that opens the enrollment sheet. On dismiss the sheet returns
  // screen-reader focus here rather than to the top of Settings, so a
  // VoiceOver user who cancels can immediately try again.
  const enrollButtonRef = useRef<View>(null);

  async function onEnrollTotp() {
    if (!baseUrl || mode !== "session") return;
    setTotpBusy(true);
    try {
      const api = createAuthClient(baseUrl);
      const res = await api.totpEnroll();
      if (res.error || !res.data) {
        Alert.alert(
          "Couldn't enroll",
          res.error?.message ?? "TOTP enrollment failed",
        );
        return;
      }
      setEnrollData({
        otpauth_uri: res.data.otpauth_uri,
        recovery_codes: res.data.recovery_codes,
      });
      setEnrollOpen(true);
    } finally {
      setTotpBusy(false);
    }
  }

  async function verifyTotpCode(code: string) {
    if (!baseUrl) return false;
    const api = createAuthClient(baseUrl);
    const res = await api.totpVerify(code);
    if (res.error || !res.data?.verified) {
      return {
        ok: false,
        message: res.error?.message ?? "The server did not confirm verification.",
      };
    }
    try {
      await refreshSession();
      return true;
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "Two-factor was verified, but the session could not be refreshed.",
      };
    }
  }

  async function onDisableTotp() {
    if (!baseUrl || mode !== "session" || !session) return;
    if (session.mfaRequired) {
      Alert.alert(
        "Required by workspace policy",
        "Two-factor authentication cannot be removed while your workspace policy requires it for your role.",
      );
      return;
    }
    if (!session.mfaSatisfied) {
      Alert.alert(
        "Verify before disabling",
        "Enter a current authenticator or recovery code before changing your two-factor security.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Verify",
            onPress: () =>
              router.push({
                pathname: "/(auth)/totp",
                params: { purpose: "security_settings" },
              }),
          },
        ],
      );
      return;
    }
    Alert.alert(
      "Disable two-factor?",
      "Your account will accept password-only sign-in until you re-enroll.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disable",
          style: "destructive",
          onPress: async () => {
            setTotpBusy(true);
            try {
              const api = createAuthClient(baseUrl);
              const res = await api.totpDisable();
              if (res.error) {
                Alert.alert("Couldn't disable", res.error.message);
                return;
              }
              try {
                await refreshSession();
              } catch (error) {
                Alert.alert(
                  "Disabled, refresh needed",
                  error instanceof Error
                    ? error.message
                    : "Two-factor was disabled, but the local session could not be refreshed.",
                );
                return;
              }
              Alert.alert("Disabled", "Two-factor auth was removed.");
            } finally {
              setTotpBusy(false);
            }
          },
        },
      ],
    );
  }

  if (mode !== "session" || !session) return null;

  return (
    <>
      <SectionHeader
        anchor="security"
        title="Security"
        subtitle="Two-factor authentication via TOTP."
      />
      <Card>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 8,
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.fg,
              ...typeStyle("callout"),
              fontFamily: FONT.regular,
            }}
          >
            TOTP {session.hasTotp ? "enabled" : "not enabled"}
          </Text>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: session.hasTotp ? t.success : t.fgSubtle,
            }}
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
        </View>
        {session.hasTotp ? (
          <Pressable
            onPress={() => void onDisableTotp()}
            disabled={totpBusy}
            accessibilityRole="button"
            accessibilityLabel="Disable two-factor authentication"
            accessibilityState={{ disabled: totpBusy, busy: totpBusy }}
            style={{
              paddingVertical: 10,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: t.danger,
              backgroundColor: `${t.danger}1a`,
              alignItems: "center",
              justifyContent: "center",
              minHeight: 44,
              opacity: totpBusy ? 0.6 : 1,
            }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.danger,
                ...typeStyle("callout"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              Disable two-factor
            </Text>
          </Pressable>
        ) : (
          <Pressable
            ref={enrollButtonRef}
            onPress={() => void onEnrollTotp()}
            disabled={totpBusy}
            accessibilityRole="button"
            accessibilityLabel="Enable two-factor authentication"
            accessibilityState={{ disabled: totpBusy, busy: totpBusy }}
            style={{
              paddingVertical: 10,
              borderRadius: 10,
              backgroundColor: t.accent,
              alignItems: "center",
              justifyContent: "center",
              minHeight: 44,
              opacity: totpBusy ? 0.6 : 1,
            }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accentFg,
                ...typeStyle("callout"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              Enable two-factor
            </Text>
          </Pressable>
        )}
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          Adds a 6-digit code requirement after every password sign-in. Use any
          TOTP authenticator (1Password, Authy, Google Authenticator).
        </Text>
      </Card>
      <TotpEnrollSheet
        visible={enrollOpen}
        enrollData={enrollData}
        returnFocusRef={enrollButtonRef}
        onVerify={verifyTotpCode}
        onClose={() => setEnrollOpen(false)}
        onVerified={() => {
          setEnrollOpen(false);
        }}
      />
    </>
  );
}
