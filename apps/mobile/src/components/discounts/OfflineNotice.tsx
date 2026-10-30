/**
 * OfflineNotice — "you're offline AND nothing was cached", for the Discounts
 * list.
 *
 * Distinct from `CachedNotice`, which says "this IS a snapshot, taken at T".
 * This is the other half of the same honesty rule: a discount catalogue that
 * never reached this phone must not fall through to "No discount codes", which
 * is a claim about the workspace rather than about the connection.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function OfflineNotice() {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel="You're offline. No discount snapshot has been saved on this phone yet. Codes you load while online are kept for twelve hours."
      style={{
        backgroundColor: t.surface,
        borderColor: t.warning,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        marginBottom: 8,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.warning,
          fontWeight: "700",
          fontFamily: FONT.bold,
          ...typeStyle("callout"),
        }}
      >
        You&apos;re offline
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginTop: 4,
          fontFamily: FONT.regular,
        }}
      >
        No discount snapshot has been saved on this phone yet. Codes you load
        while online are kept for twelve hours.
      </Text>
    </View>
  );
}
