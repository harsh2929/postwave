/**
 * components/scan/ScanPermissionPrompt — the branded rationale shown before
 * (and after) the OS camera dialog.
 *
 * Two distinct states in one component because they differ only in words and in
 * what the button does:
 *
 *   - NOT YET ASKED — explain what the camera is for, then spend the one-shot
 *     OS prompt. iOS gives an app exactly one chance at that dialog per install,
 *     so asking cold is the one thing you cannot take back.
 *   - REFUSED (`canAskAgain === false`) — the OS will not show the dialog again,
 *     so the only honest affordance is a link into system Settings. Offering
 *     "Allow camera" here would be a button that provably does nothing.
 *
 * Every `Text` is on the shared Dynamic Type scale and the column is centred
 * with no fixed heights, so the copy reflows at large accessibility sizes
 * instead of pushing the button off the bottom of the screen.
 */
import * as Linking from "expo-linking";
import { Pressable, Text, View } from "react-native";

import { TabBarIcon } from "@/components/TabBarIcon";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ScanPermissionPrompt({
  t,
  denied,
  onRequest,
}: {
  t: ReturnType<typeof useTheme>["t"];
  /** True when the OS will no longer show its dialog — Settings is the only way. */
  denied: boolean;
  onRequest: () => void;
}) {
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 32,
      }}
    >
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: 20,
          backgroundColor: t.accentSubtle,
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 20,
        }}
      >
        <TabBarIcon name="link" color={t.accent} size={32} />
      </View>
      <Text
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          textAlign: "center",
        }}
      >
        Scan a Moosewave code
      </Text>
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fgMuted,
          ...typeStyle("callout"),
          fontFamily: FONT.regular,
          textAlign: "center",
          marginTop: 8,
        }}
      >
        {denied
          ? "Camera access is off. Enable it in Settings to scan a QR from your desktop and open it here."
          : "Moosewave needs your camera to scan a QR code shown on your desktop and open that campaign or subscriber on your phone."}
      </Text>
      <Pressable
        onPress={() => {
          if (denied) void Linking.openSettings();
          else onRequest();
        }}
        accessibilityRole="button"
        accessibilityLabel={denied ? "Open Settings" : "Allow camera access"}
        style={{
          marginTop: 24,
          minHeight: 44,
          justifyContent: "center",
          paddingHorizontal: 24,
          paddingVertical: 13,
          borderRadius: 12,
          backgroundColor: t.accent,
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.accentFg,
            ...typeStyle("body"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
            textAlign: "center",
          }}
        >
          {denied ? "Open Settings" : "Allow camera"}
        </Text>
      </Pressable>
    </View>
  );
}
