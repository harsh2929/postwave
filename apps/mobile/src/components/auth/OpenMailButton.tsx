/**
 * OpenMailButton — one tap from "we sent you a link" to the inbox.
 *
 * Every magic-link flow in the app ended at "check your email" and offered
 * only Resend and Back, so the unambiguous next action — go read your inbox —
 * required the user to leave the app by hand.
 *
 * The button hides itself when no mail client can be opened rather than
 * shipping a control that does nothing: on iOS `message://` resolves only when
 * Mail is installed (it can be deleted), and Gmail is the common replacement.
 */
import { useEffect, useState } from "react";
import {
  Linking,
  Platform,
  Pressable,
  Text,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Checked in order; the first one the OS can open wins. */
const IOS_MAIL_SCHEMES = ["message://", "googlegmail://", "ms-outlook://"];

export function OpenMailButton({ style }: { style?: StyleProp<ViewStyle> }) {
  const { t } = useTheme();
  const [target, setTarget] = useState<string | null>(
    Platform.OS === "android" ? "android-intent" : null,
  );

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let cancelled = false;
    void (async () => {
      for (const scheme of IOS_MAIL_SCHEMES) {
        try {
          if (await Linking.canOpenURL(scheme)) {
            if (!cancelled) setTarget(scheme);
            return;
          }
        } catch {
          // canOpenURL throws for un-declared schemes on some iOS versions;
          // treat that as "not available" and keep checking the rest.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!target) return null;

  async function open(): Promise<void> {
    haptics.tap();
    try {
      if (Platform.OS === "android") {
        await Linking.sendIntent("android.intent.action.MAIN", [
          { key: "android.intent.category.APP_EMAIL", value: "" },
        ]);
        return;
      }
      if (target) await Linking.openURL(target);
    } catch {
      // No mail client responded. Nothing useful to say — the Resend and
      // Back actions directly below remain available.
    }
  }

  return (
    <Pressable
      onPress={() => void open()}
      accessibilityRole="button"
      accessibilityLabel="Open your mail app"
      style={[
        {
          paddingVertical: 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
          alignItems: "center",
          justifyContent: "center",
          minHeight: 44,
        },
        style,
      ]}
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
        Open Mail app
      </Text>
    </Pressable>
  );
}
