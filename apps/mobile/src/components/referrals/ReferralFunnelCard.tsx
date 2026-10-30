/**
 * The conversion funnel, as five measurements.
 *
 * EVERY VALUE GOES THROUGH `num()`, which renders `null` as an em-dash. That is
 * not a stylistic choice: `parseReferralFunnel` returns null for a field the
 * server did not send, and printing 0 there would state "no one referred
 * anyone" on the strength of a payload that said nothing at all. A genuine 0
 * still prints 0.
 *
 * NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import { num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import type { ReferralFunnel } from "@/lib/referrals";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface ReferralFunnelCardProps {
  funnel: ReferralFunnel;
  topReferrerCount: number | null;
}

export function ReferralFunnelCard({
  funnel,
  topReferrerCount,
}: ReferralFunnelCardProps) {
  const { t } = useTheme();
  const cells: { label: string; value: number | null; hint: string }[] = [
    {
      label: "Last 7 days",
      value: funnel.conversions7d,
      hint: "Credited referral conversions in the last seven days",
    },
    {
      label: "Last 30 days",
      value: funnel.conversions30d,
      hint: "Credited referral conversions in the last thirty days",
    },
    {
      label: "Last 90 days",
      value: funnel.conversions90d,
      hint: "Credited referral conversions in the last ninety days",
    },
    {
      label: "Clicks (all time)",
      value: funnel.clicksTotal,
      hint: "Total referral link clicks recorded across the programme's lifetime",
    },
    {
      label: "Filtered as fraud",
      value: funnel.fraudFilteredCount,
      hint: "Conversions the fraud score excluded from every count above",
    },
    {
      label: "Referrers (90d)",
      value: topReferrerCount,
      hint: "Distinct subscribers who referred at least one person in the last ninety days",
    },
  ];
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.border,
        borderWidth: 1,
        borderRadius: 12,
        marginHorizontal: 16,
        marginTop: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        flexDirection: "row",
        flexWrap: "wrap",
        rowGap: 14,
      }}
    >
      {cells.map((cell) => (
        <View
          key={cell.label}
          accessible
          accessibilityLabel={`${cell.label}: ${num(cell.value)}. ${cell.hint}.`}
          style={{ width: "50%", paddingEnd: 8 }}
        >
          <Text
            {...typeCap("figure")}
            style={{
              color: t.fg,
              ...typeStyle("figure"),
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            {num(cell.value)}
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              marginTop: 2,
              fontFamily: FONT.regular,
            }}
          >
            {cell.label}
          </Text>
        </View>
      ))}
    </View>
  );
}
