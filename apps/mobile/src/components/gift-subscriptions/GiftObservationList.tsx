/**
 * GiftObservationList — the findings, above the ledger they came from.
 *
 * Severity is carried by the LABEL as well as the swatch: a warning row says
 * "Needs attention" in words, so a reader who cannot distinguish the two
 * colours still gets the distinction (house rule 4 — state is never
 * colour-alone).
 *
 * NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import type { GiftObservation } from "@/lib/giftInsights";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function GiftObservationList({
  items,
}: {
  items: readonly GiftObservation[];
}) {
  const { t } = useTheme();
  if (items.length === 0) return null;
  return (
    <View style={{ gap: 8 }}>
      {items.map((item) => {
        const warn = item.severity === "warn";
        const tone = warn ? t.warning : t.info;
        return (
          <View
            key={item.id}
            accessible
            accessibilityLabel={`${warn ? "Needs attention" : "For information"}. ${item.title}. ${item.detail}`}
            style={{
              backgroundColor: t.surface,
              borderColor: t.borderSubtle,
              borderWidth: 1,
              borderStartColor: tone,
              borderStartWidth: 3,
              borderRadius: 12,
              paddingHorizontal: 12,
              paddingVertical: 10,
            }}
          >
            <Text
              {...typeCap("caption")}
              style={{
                color: tone,
                ...typeStyle("caption"),
                fontFamily: FONT.semibold,
                letterSpacing: 0.4,
                textTransform: "uppercase",
              }}
            >
              {warn ? "Needs attention" : "For information"}
            </Text>
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                marginTop: 2,
                fontWeight: "700",
                fontFamily: FONT.bold,
              }}
            >
              {item.title}
            </Text>
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgMuted,
                ...typeStyle("label"),
                marginTop: 3,
                fontFamily: FONT.regular,
              }}
            >
              {item.detail}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
