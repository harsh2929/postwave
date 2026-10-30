/**
 * SettingsFooter — sign-out plus the build stamp.
 *
 * Extracted from the Settings screen to pay for the section index: that file
 * sits under a legacy line ratchet, so anything added to it has to be funded by
 * moving an equal amount out rather than by raising the ceiling.
 *
 * The build stamp is the substantive change here. It used to be dead,
 * unselectable text: a support engineer asking "what build are you on?" had no
 * way for the user to answer — this app has no clipboard dependency. It now
 * opens Diagnostics, which owns the single shareable report, rather than
 * growing a second, divergent copy of one here.
 */
import * as Application from "expo-application";
import { router } from "expo-router";
import { Pressable, Text } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SettingsFooter({
  signingOut,
  onSignOut,
}: {
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const { t } = useTheme();
  const version = Application.nativeApplicationVersion ?? "0.1.0";
  const build = Application.nativeBuildVersion ?? "1";
  return (
    <>
      <Pressable
        onPress={onSignOut}
        disabled={signingOut}
        accessibilityState={{ disabled: signingOut, busy: signingOut }}
        accessibilityRole="button"
        accessibilityLabel="Sign out"
        style={{
          marginTop: 24,
          paddingVertical: 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.danger,
          backgroundColor: `${t.danger}1a`,
          alignItems: "center",
          opacity: signingOut ? 0.5 : 1,
        }}
      >
        <Text
          // Button label: prose, and the button is padding-sized rather than
          // fixed-height, so it grows with the label.
          {...typeCap("body")}
          style={{
            color: t.danger,
            ...typeStyle("body"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </Text>
      </Pressable>

      <Pressable
        onPress={() => router.push("/(tabs)/diagnostics")}
        accessibilityRole="link"
        accessibilityLabel={`Moosewave Mobile version ${version}, build ${build}`}
        accessibilityHint="Opens diagnostics you can share with support."
        style={{ marginTop: 24, minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            textAlign: "center",
            fontFamily: FONT.regular,
          }}
        >
          {`Moosewave Mobile · v${version} · build ${build}`}
        </Text>
      </Pressable>
    </>
  );
}
