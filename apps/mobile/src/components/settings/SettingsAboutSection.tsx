/**
 * SettingsAboutSection — the two rows the mobile About block was missing.
 *
 * Desktop's About section (apps/desktop/src/pages/Settings.tsx) has four rows:
 * App version, Source, Legal and Privacy contact. Mobile had the version (in
 * SettingsFooter, which routes it to Diagnostics) and Legal (LegalLinks in the
 * "Legal and support" card) but neither Source nor a privacy contact — so a
 * user with a GDPR question had no address to write to from inside the app,
 * which several app-store privacy reviews expect to find.
 *
 * Both rows FAIL LOUD rather than silently: `Linking.canOpenURL` is checked
 * before opening, and a device with no browser / no mail client gets an
 * explicit toast instead of a tap that does nothing. That is the same
 * treatment DataExportsSection gives its signed download URLs.
 */
import * as Linking from "expo-linking";
import { Pressable, Text, View } from "react-native";

import { useToast } from "@/components/Toast";
import { PRIVACY_CONTACT_EMAIL, SOURCE_URL } from "@/lib/config";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SettingsAboutSection() {
  const { t } = useTheme();
  const { toast } = useToast();

  async function open(url: string, failure: string): Promise<void> {
    haptics.tap();
    try {
      // canOpenURL can throw for an un-declared scheme on some iOS versions,
      // so the throw is treated exactly like a `false`.
      if (!(await Linking.canOpenURL(url))) {
        toast({ kind: "warning", message: failure });
        return;
      }
      await Linking.openURL(url);
    } catch {
      toast({ kind: "error", message: failure });
    }
  }

  return (
    <View style={{ gap: 2 }}>
      <AboutRow
        t={t}
        label="Source"
        value={SOURCE_URL.replace(/^https:\/\//, "").replace(/\/$/, "")}
        accessibilityLabel={`Source code, ${SOURCE_URL}`}
        hint="Opens the repository in your browser."
        onPress={() =>
          void open(
            SOURCE_URL,
            "No browser on this device could open the repository link.",
          )
        }
      />
      <AboutRow
        t={t}
        label="Privacy contact"
        value={PRIVACY_CONTACT_EMAIL}
        accessibilityLabel={`Privacy contact, ${PRIVACY_CONTACT_EMAIL}`}
        hint="Opens a new message in your mail app."
        onPress={() =>
          void open(
            `mailto:${PRIVACY_CONTACT_EMAIL}`,
            `No mail app is set up on this device. Write to ${PRIVACY_CONTACT_EMAIL}.`,
          )
        }
      />
    </View>
  );
}

function AboutRow({
  t,
  label,
  value,
  accessibilityLabel,
  hint,
  onPress,
}: {
  t: ReturnType<typeof useTheme>["t"];
  label: string;
  value: string;
  accessibilityLabel: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={hint}
      // Static style object: a function-style `style` on a Pressable silently
      // drops layout under NativeWind v4.
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        minHeight: 44,
      }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.accent,
          ...typeStyle("bodySmall"),
          flexShrink: 1,
          textAlign: "right",
          fontFamily: FONT.regular,
        }}
      >
        {value}
      </Text>
    </Pressable>
  );
}
