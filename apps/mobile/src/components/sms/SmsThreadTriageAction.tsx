/**
 * SmsThreadTriageAction — the "Triage" control in the thread's screen header.
 *
 * A header accessory with a 44pt target, its own haptic, and no state; it is a
 * file of its own only so `app/(tabs)/sms/[phone].tsx` can pass it as one
 * expression instead of carrying thirty lines of styling inside the screen
 * function. The verbs it opens are decided by `smsTriageOptions`.
 */
import { Pressable, Text } from "react-native";

import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SmsThreadTriageAction({ onPress }: { onPress: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel="Triage this conversation"
      accessibilityHint="Snooze, archive or assign this conversation"
      hitSlop={8}
      style={{
        minHeight: 44,
        minWidth: 44,
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: t.accent,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        Triage
      </Text>
    </Pressable>
  );
}
