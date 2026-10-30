import type { ReactNode } from "react";
import { Text, View, type StyleProp, type TextStyle } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * The subscriber detail's `Card` was a third declaration of the shared
 * primitive's default variant (surface / subtle border / radius 16 /
 * padding 16), differing only in accepting `style` and `onLayout` — both of
 * which the shared component already takes as ViewProps. Re-exported so the
 * detail sections keep their import path while card geometry has exactly one
 * definition (src/lib/shellStyleTokens.ts).
 */
export { Card } from "@/components/Card";

export function Label({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  const { t } = useTheme();
  return (
    <Text
      // Uppercase section heading — the smallest PROSE step, so it reflows
      // and is allowed to grow a long way.
      {...typeCap("caption")}
      style={[
        {
          color: t.fgMuted,
          ...typeStyle("caption"),
          letterSpacing: 0.6,
          fontWeight: "600",
          fontFamily: FONT.semibold,
          textTransform: "uppercase",
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function MiniStat({
  label,
  value,
  sub,
  t,
}: {
  label: string;
  value: string;
  sub?: string | null;
  t: ThemeTokens;
}) {
  return (
    <View
      style={{
        flexBasis: "31%",
        flexGrow: 1,
        minWidth: 96,
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
      }}
    >
      {/* All three lines take DENSE roles: the tile is one cell of a
          three-across `flexBasis: "31%"` row, so growth here re-flows the
          grid rather than the text. */}
      <Text
        {...typeCap("badgeSmall")}
        // One line, shrinking rather than breaking. The tile is 31% of the row
        // and these labels are UPPERCASE with letterSpacing, so a single long
        // word has no space to wrap at and React Native breaks it MID-WORD:
        // "SUBSCRIBERS" rendered as "SUBSCRIBER" / "S" on the audience growth
        // card. Observed in-app on 2026-08-19.
        //
        // minimumFontScale keeps the shrink bounded, so a large-text setting
        // still enlarges this label -- it just stops one word short of
        // splitting itself in half.
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.85}
        style={{
          color: t.fgMuted,
          ...typeStyle("badgeSmall"),
          letterSpacing: 0.5,
          fontWeight: "600",
          fontFamily: FONT.semibold,
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
      {/* Deliberately 18, not the 30 of `figure`: this is the COMPACT stat
          tile (three per row on a phone), where the dashboard's hero size
          would not fit at any text setting. The `figure` CEILING is still
          the right one — it is the tightest in the scale precisely because
          this text lives in a grid cell that cannot grow with it. */}
      <Text
        {...typeCap("figure")}
        style={{
          color: t.fg,
          fontSize: 18,
          lineHeight: 22,
          fontWeight: "700",
          fontFamily: FONT.display,
          marginTop: 2,
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
      </Text>
      {sub ? (
        <Text
          {...typeCap("badgeSmall")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("badgeSmall"),
            marginTop: 1,
            fontVariant: ["tabular-nums"],
            fontFamily: FONT.regular,
          }}
        >
          {sub}
        </Text>
      ) : null}
    </View>
  );
}
