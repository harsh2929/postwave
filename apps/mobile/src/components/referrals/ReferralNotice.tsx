/**
 * The banner for a CLOSED referral runtime: the figures below are a historical
 * record and not a live counter.
 *
 * ONLY RENDERED WHEN `REFERRAL_RUNTIME_AVAILABLE` IS FALSE. ReferralsScreen owns
 * that branch. Every sentence in `REFERRAL_RUNTIME_NOTICE` is a claim about the
 * build — "no new conversion is being credited" — so with the gate open this
 * component states a falsehood about live data, which is exactly the bug that
 * moved the render behind a condition.
 *
 * It is kept, not deleted, because the Go constant is a release boundary that
 * can close again. Without it, "7-day conversions —" reads as a failing
 * programme rather than a switched-off one, and an operator goes looking for a
 * bug that is actually a release gate.
 *
 * Copy lives in lib/referrals so the screen and its test cannot drift apart.
 * NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { REFERRAL_RUNTIME_NOTICE } from "@/lib/referrals";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ReferralNotice() {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={REFERRAL_RUNTIME_NOTICE.spoken}
      style={{
        backgroundColor: t.surface,
        borderColor: t.warning,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        marginHorizontal: 16,
        marginTop: 12,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.warning,
          ...typeStyle("bodySmall"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        {REFERRAL_RUNTIME_NOTICE.headline}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 4,
          fontFamily: FONT.regular,
        }}
      >
        {REFERRAL_RUNTIME_NOTICE.detail}
      </Text>
    </View>
  );
}
