/**
 * SignificanceBadge (mobile) — RN port of the desktop's pairwise
 * significance indicator. Green check when the test crossed the
 * threshold, neutral dot otherwise. The label spells out the
 * threshold so operators don't have to remember whether 95% means
 * raw or Bonferroni-corrected.
 */
import { Text, View } from "react-native";

import { TINT_ALPHA_STRONG, withAlpha } from "@/lib/color";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface SignificanceBadgeProps {
  significant: boolean;
  /** Short label e.g. "95%" / "99%" / "Bonferroni". */
  label?: string;
  /** Long-form text rendered below the badge as a hint. */
  hint?: string;
}

export function SignificanceBadge({
  significant,
  label = "95%",
  hint,
}: SignificanceBadgeProps) {
  const { t } = useTheme();
  const color = significant ? t.success : t.fgSubtle;
  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          alignSelf: "flex-start",
          backgroundColor: significant
            ? withAlpha(t.success, TINT_ALPHA_STRONG)
            : t.bgSubtle,
          paddingHorizontal: 10,
          paddingVertical: 4,
          borderRadius: 999,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color,
            fontSize: 13,
            fontWeight: "700",
            fontFamily: FONT.bold,
          }}
        >
          {significant ? "✓" : "·"}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color,
            fontSize: 11,
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {significant ? `Significant @ ${label}` : "Not significant"}
        </Text>
      </View>
      {hint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontSize: 11,
            marginTop: 4,
            fontFamily: FONT.regular,
          }}
          numberOfLines={2}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
