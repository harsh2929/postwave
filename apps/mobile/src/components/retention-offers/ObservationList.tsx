/**
 * ObservationList — the sentences an operator would have derived themselves
 * after reading every number on the screen.
 *
 * Each line comes from `retentionObservations`, which is pure and unit-tested,
 * and every line is derived from a fact that is actually on the wire. There is
 * deliberately no "acceptance rate looks low" line: with the portal accept /
 * decline routes unmounted (retention_offers/handlers.go:46-53 registers
 * neither), an acceptance cannot currently be recorded at all, so a low rate
 * is evidence of nothing.
 *
 * Tone is carried by a WORD as well as a colour — "Needs attention" / "Good" —
 * so the list still parses in greyscale and to a colour-blind reader.
 *
 * NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import type { RetentionObservation } from "@/lib/retentionOffers";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const TONE_WORD: Record<RetentionObservation["tone"], string> = {
  attention: "Needs attention",
  info: "Note",
  good: "Good",
};

export function ObservationList({
  items,
}: {
  items: readonly RetentionObservation[];
}) {
  const { t } = useTheme();
  if (items.length === 0) return null;

  return (
    <View style={{ gap: 8 }}>
      {items.map((item) => {
        const accent =
          item.tone === "attention"
            ? t.warning
            : item.tone === "good"
              ? t.success
              : t.fgMuted;
        return (
          <View
            key={item.id}
            accessible
            accessibilityLabel={`${TONE_WORD[item.tone]}. ${item.text}`}
            style={{
              backgroundColor: t.bgSubtle,
              borderRadius: 12,
              // START, not LEFT: the whole layout mirrors on an RTL locale
              // (android supportsRtl="true"), and a physical border would
              // leave the accent stripe stranded on the trailing edge. Same
              // reasoning as the Toast stripe (Toast.tsx:274-277).
              borderStartColor: accent,
              borderStartWidth: 3,
              paddingHorizontal: 12,
              paddingVertical: 10,
            }}
          >
            <Text
              {...typeCap("label")}
              style={{
                color: accent,
                ...typeStyle("label"),
                letterSpacing: 0.4,
                textTransform: "uppercase",
                fontFamily: FONT.semibold,
              }}
            >
              {TONE_WORD[item.tone]}
            </Text>
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                marginTop: 2,
                fontFamily: FONT.regular,
              }}
            >
              {item.text}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
