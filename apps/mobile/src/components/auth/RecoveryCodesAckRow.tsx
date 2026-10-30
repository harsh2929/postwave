/**
 * RecoveryCodesAckRow — the "I've saved my recovery codes" attestation.
 *
 * The checkbox gates the Confirm button, so it must not be tickable before the
 * codes have actually left the screen: the server issues them exactly once
 * (`GenerateRecoveryCodes` runs inside TOTPEnroll and there is no regenerate
 * route), and a user who ticks this box on trust is one lost phone away from
 * being locked out permanently. Tapping it early explains why instead of
 * silently doing nothing — a disabled control with no reason is a dead end.
 */
import { Alert, Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { MIN_TOUCH_TARGET } from "@/lib/displayPreferences";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function RecoveryCodesAckRow({
  acknowledged,
  savedCodes,
  onToggle,
}: {
  acknowledged: boolean;
  /** True once the share sheet has actually been dismissed with an action. */
  savedCodes: boolean;
  onToggle: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => {
        if (!savedCodes) {
          haptics.warning();
          Alert.alert(
            "Save them first",
            "Use “Save recovery codes…” above, then confirm you have them.",
          );
          return;
        }
        onToggle();
      }}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: acknowledged, disabled: !savedCodes }}
      accessibilityHint={
        savedCodes
          ? "Confirms you have stored your recovery codes."
          : "Save your recovery codes before confirming."
      }
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: MIN_TOUCH_TARGET,
        gap: 10,
        marginBottom: 24,
      }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: acknowledged ? t.accent : t.border,
          backgroundColor: acknowledged ? t.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {acknowledged ? (
          /* Checkmark ICON inside a fixed 18x18 box; the row's own
             accessibilityState carries the checked state to VoiceOver, so this
             glyph is decorative and pinned against OS text scaling. */
          <Text
            allowFontScaling={false}
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{
              color: t.accentFg,
              ...typeStyle("label"),
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            ✓
          </Text>
        ) : null}
      </View>
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          flex: 1,
          fontFamily: FONT.regular,
        }}
      >
        I&apos;ve saved my recovery codes
      </Text>
    </Pressable>
  );
}
