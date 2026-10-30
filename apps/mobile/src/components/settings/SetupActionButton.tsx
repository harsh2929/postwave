/**
 * SetupActionButton — the single full-width button the workspace-setup cards
 * use. Extracted only so the Slack and sample-data cards cannot drift apart on
 * height, disabled opacity or the busy label, which is exactly what happened
 * across the four settings sections that each declared their own.
 *
 * `busyLabel` is required rather than optional: a button that keeps its resting
 * label while a request is in flight is the classic double-tap bug, and the
 * spoken state has to change too, not just the opacity.
 */
import { Pressable, Text } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SetupActionButton({
  label,
  busyLabel,
  busy,
  disabled,
  tone = "neutral",
  accessibilityHint,
  onPress,
  testID,
}: {
  label: string;
  busyLabel: string;
  busy: boolean;
  disabled?: boolean | undefined;
  /** `danger` tints the border + text; the label still says what it does. */
  tone?: "neutral" | "danger";
  accessibilityHint?: string | undefined;
  onPress: () => void;
  testID?: string | undefined;
}) {
  const { t } = useTheme();
  const inactive = busy || Boolean(disabled);
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={busy ? busyLabel : label}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      accessibilityState={{ disabled: inactive, busy }}
      testID={testID}
      style={{
        minHeight: 44,
        justifyContent: "center",
        alignItems: "center",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: tone === "danger" ? t.danger : t.border,
        backgroundColor: t.surface,
        opacity: inactive ? 0.6 : 1,
      }}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: tone === "danger" ? t.danger : t.fg,
          ...typeStyle("body"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        {busy ? busyLabel : label}
      </Text>
    </Pressable>
  );
}
