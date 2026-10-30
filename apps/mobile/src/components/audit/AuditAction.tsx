/**
 * AuditAction — the bordered, full-width-share action button the governance
 * cluster uses for "Reset circuit", "Send test event", "Replay", "Export".
 *
 * It started life as `SinkAction` inside SinkCard and was already being used by
 * DlqCard, which is not a sink; the export sheet made it a third caller. A
 * button used by three unrelated cards is a component, not a private helper.
 *
 * Two things it must keep getting right:
 *   - `accessibilityState={{ disabled }}` as well as the visual opacity, so a
 *     disabled control is disabled to VoiceOver and not merely faint.
 *   - 44pt minimum height and a two-line, centred label, so raising the OS text
 *     size grows the button rather than clipping the verb inside it.
 */
import { Pressable, Text } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AuditActionProps {
  label: string;
  hint: string;
  /** Accent border + accent label for the primary action in a pair. */
  emphasis?: boolean;
  /** Danger border + danger label for an irreversible verb (e.g. Delete). */
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

export function AuditAction({
  label,
  hint,
  emphasis,
  destructive,
  disabled,
  onPress,
}: AuditActionProps) {
  const { t } = useTheme();
  const colour = destructive ? t.danger : emphasis ? t.accent : t.fgMuted;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled ?? false}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={{
        flex: 1,
        minHeight: 44,
        paddingHorizontal: 10,
        paddingVertical: 8,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: destructive ? t.danger : emphasis ? t.accent : t.border,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text
        {...typeCap("control")}
        numberOfLines={2}
        style={{
          color: colour,
          fontWeight: "700",
          fontFamily: FONT.bold,
          textAlign: "center",
          ...typeStyle("control"),
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
