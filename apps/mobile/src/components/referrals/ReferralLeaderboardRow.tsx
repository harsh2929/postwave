/**
 * One ranked referrer.
 *
 * The address is ALREADY masked when it arrives — `maskEmail` runs server-side
 * in apps/api/internal/referrals/leaderboard.go, whose own header says the
 * unmasked drill-down deliberately stays on /subscribers/{id}/referral. The
 * parser never falls back to any other identity field, so nothing on this row
 * can become an unmasked address by accident. That is what makes a leaderboard
 * safe to render on a phone that may be handed across a table.
 *
 * NativeWind v4: static style objects only — this row is not pressable, there
 * is nothing to drill into (the drill-down endpoint is behind the closed
 * runtime).
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { num, plural } from "@/lib/format";
import type { ReferralLeaderboardRow as Row } from "@/lib/referrals";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ReferralLeaderboardRow({ row }: { row: Row }) {
  const { t } = useTheme();
  const milestone =
    row.milestone > 0 ? `Tier ${num(row.milestone)}` : "No tier unlocked";
  return (
    <View
      accessible
      accessibilityLabel={`Rank ${num(row.rank)}. ${row.emailMasked}. ${plural(row.conversions, "referral")}. ${milestone}.`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderBottomColor: t.borderSubtle,
        borderBottomWidth: 1,
      }}
    >
      <Text
        {...typeCap("numeric")}
        style={{
          color: t.fgMuted,
          ...typeStyle("numeric"),
          fontWeight: "700",
          fontFamily: FONT.bold,
          minWidth: 28,
        }}
      >
        {num(row.rank)}
      </Text>
      <View style={{ flex: 1 }}>
        <Text
          {...typeCap("bodySmall")}
          numberOfLines={1}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {row.emailMasked}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {milestone}
        </Text>
      </View>
      <Text
        {...typeCap("numeric")}
        style={{
          color: t.fg,
          ...typeStyle("numeric"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        {num(row.conversions)}
      </Text>
    </View>
  );
}
