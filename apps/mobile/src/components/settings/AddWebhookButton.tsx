/**
 * AddWebhookButton — the control that opens the create form in Settings.
 *
 * It is only a button: opening the form is the caller's state change, because
 * the section owns the rule that only ever ONE form is open at a time.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function AddWebhookButton({ onPress }: { onPress: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Add an outbound webhook"
      style={{
        borderRadius: 10,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.surface,
        alignItems: "center",
        justifyContent: "center",
        minHeight: 44,
      }}
    >
      <Text
        style={{
          color: t.fg,
          ...typeStyle("control"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
        {...typeCap("control")}
      >
        + Add webhook
      </Text>
    </Pressable>
  );
}
