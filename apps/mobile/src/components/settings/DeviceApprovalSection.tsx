import { router } from "expo-router";
import { Pressable, Text } from "react-native";

import {
  Card,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Discoverable manual-code fallback for camera-less cross-device login. */
export function DeviceApprovalSection() {
  const { t } = useTheme();
  return (
    <>
      <SectionHeader
        title="Sign in another device"
        subtitle="Scan its QR from the Scan tab, or enter its short code here."
      />
      <Card>
        <Pressable
          onPress={() => router.push("/(tabs)/cli-approve")}
          accessibilityRole="button"
          accessibilityLabel="Enter a device sign-in code"
          accessibilityHint="Opens the review screen. Nothing is approved until you confirm there."
          style={{
            minHeight: 48,
            justifyContent: "center",
            paddingVertical: 6,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.accent,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
            }}
          >
            Enter a device code
          </Text>
        </Pressable>
      </Card>
    </>
  );
}
