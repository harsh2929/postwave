/**
 * RecipientTimezoneCard — the "quiet hours follow each recipient" switch.
 *
 * Extracted verbatim from app/(tabs)/sending-settings.tsx when the IP-pool
 * card landed: that screen sits at its legacy line ceiling, and the switch
 * block was its most self-contained stretch (one boolean in, one boolean
 * out). Behaviour is unchanged.
 */
import { Switch, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function RecipientTimezoneCard({
  value,
  onChange,
  disabled = false,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.border,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 14,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
          }}
        >
          Use each recipient&apos;s timezone
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 3,
            fontFamily: FONT.regular,
          }}
        >
          When off, quiet hours use the workspace timezone above for everyone.
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={(next) => {
          haptics.tap();
          onChange(next);
        }}
        accessibilityLabel="Use each recipient's timezone for quiet hours"
        accessibilityState={{ checked: value, disabled }}
        disabled={disabled}
        trackColor={{ false: t.border, true: t.accent }}
      />
    </View>
  );
}
