/**
 * AuditActivityCard — "is activity normal today?", above the feed.
 *
 * A phone glance at governance should answer whether anything is UNUSUAL
 * before it answers what the last hundred events were. The server has computed
 * the per-day series all along; this client rendered only the raw feed, so the
 * one question a pager-woken reader actually has took a hundred rows of manual
 * scanning to answer.
 *
 * Everything judgemental — the baseline, the elevated threshold, the wording —
 * lives in lib/auditStats and is asserted in the node test environment. This
 * file paints it, and does two things that matter for how it is read:
 *
 *   - THE STATE IS A WORD, NOT A COLOUR. "Elevated" is in the pill and in the
 *     headline; the tone only reinforces it.
 *   - THE SPARKLINE IS DECORATIVE TO VOICEOVER. The card is one grouped element
 *     carrying `summary.spoken`, so a screen-reader user gets the sentence
 *     rather than a chart they cannot see and a number with no baseline.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { Sparkline } from "@/components/charts/Sparkline";
import {
  auditActivityTone,
  type AuditActivitySummary,
} from "@/lib/auditStats";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AuditActivityCardProps {
  summary: AuditActivitySummary;
  loading?: boolean;
}

export function AuditActivityCard({ summary, loading }: AuditActivityCardProps) {
  const { t } = useTheme();
  // Nothing at all while the first read is in flight, and nothing when the
  // endpoint declined: a governance screen must not render an "unavailable"
  // scare card for an enrichment that is simply not enabled.
  if (loading || summary.level === "unknown") return null;
  const tone = auditActivityTone(summary.level);

  return (
    <View
      accessible
      accessibilityLabel={summary.spoken}
      style={{
        backgroundColor: t.bgSubtle,
        borderColor: summary.level === "elevated" ? t.warning : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("label")}
          numberOfLines={2}
          style={{
            color: t.fg,
            flex: 1,
            fontWeight: "700",
            fontFamily: FONT.bold,
            ...typeStyle("label"),
          }}
        >
          {summary.headline}
        </Text>
        {summary.level !== "normal" ? (
          <Pill label={summary.level} tone={tone} />
        ) : null}
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
        }}
      >
        {summary.detail}
      </Text>
      {summary.series.length > 1 ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ marginTop: 2 }}
        >
          <Sparkline
            values={summary.series}
            height={28}
            filled
            color={summary.level === "elevated" ? t.warning : t.accent}
          />
        </View>
      ) : null}
    </View>
  );
}
