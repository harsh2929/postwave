/**
 * InsightsCard — two or three plain-language observations about what moved.
 *
 * Everything load-bearing is in `lib/dashboardInsights`: which movements are
 * worth reporting, in what order, and in what words. This file renders them.
 *
 * It renders NOTHING when nothing moved, and that is the feature. A strip that
 * appears every day — "everything is steady!" — teaches the reader to skip the
 * region on the one day it has something to say, which is the same reasoning
 * behind `AnomalyHistoryCard` and `ForecastStrip` self-gating.
 *
 * Tone is carried by a WORD as well as by ink: each row is prefixed with a
 * short state label, so the card survives greyscale and colour-blindness. The
 * numbers themselves come from the compare window the dashboard already
 * fetches, so this costs no request.
 */
import { Text, View } from "react-native";

import { SectionLabel } from "@/components/SectionLabel";
import {
  pickBounceRate,
  pickCampaignsSent30d,
  pickClickRate,
  pickOpenRate,
  pickPreviousBounceRate,
  pickPreviousCampaignsSent,
  pickPreviousClickRate,
  pickPreviousOpenRate,
  pickPreviousSubscribersDelta,
  pickSubscribersDelta30d,
  type DashboardStats,
} from "@/hooks/useDashboard";
import { FONT } from "@/lib/fonts";
import {
  dashboardInsights,
  type InsightTone,
} from "@/lib/dashboardInsights";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface InsightsCardProps {
  /** The dashboard-stats payload, fetched with `compare=true`. */
  stats: DashboardStats | undefined;
  /** Reporting-window label, e.g. "Last 30 days". */
  rangeLabel: string;
}

function toneWord(tone: InsightTone): string {
  switch (tone) {
    case "positive":
      return "Improving";
    case "negative":
      return "Worsening";
    case "neutral":
      return "Context";
  }
}

export function InsightsCard({ stats, rangeLabel }: InsightsCardProps) {
  const { t } = useTheme();
  // Derived here rather than in the screen, matching `DeliverabilitySection`
  // and `InboxHealthCard`: the card that renders a fact owns the pick of it,
  // so the route file stays a layout decision.
  const insights = dashboardInsights({
    rangeLabel,
    openRate: pickOpenRate(stats),
    previousOpenRate: pickPreviousOpenRate(stats),
    clickRate: pickClickRate(stats),
    previousClickRate: pickPreviousClickRate(stats),
    bounceRate: pickBounceRate(stats),
    previousBounceRate: pickPreviousBounceRate(stats),
    subscribersDelta: pickSubscribersDelta30d(stats),
    previousSubscribersDelta: pickPreviousSubscribersDelta(stats),
    campaignsSent: pickCampaignsSent30d(stats),
    previousCampaignsSent: pickPreviousCampaignsSent(stats),
  });
  if (insights.length === 0) return null;

  const toneColor = (tone: InsightTone): string =>
    tone === "positive"
      ? t.success
      : tone === "negative"
        ? t.warning
        : t.fgSubtle;

  return (
    <View>
      <SectionLabel>What changed</SectionLabel>
      <View
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        {insights.map((insight, index) => (
          <View
            key={insight.id}
            accessible
            accessibilityLabel={`${toneWord(insight.tone)}. ${insight.text}`}
            style={{
              gap: 4,
              paddingVertical: 12,
              paddingHorizontal: 14,
              borderTopWidth: index === 0 ? 0 : 1,
              borderTopColor: t.borderSubtle,
            }}
          >
            <Text
              {...typeCap("caption")}
              style={{
                color: toneColor(insight.tone),
                ...typeStyle("caption"),
                letterSpacing: 0.6,
                fontFamily: FONT.semibold,
                textTransform: "uppercase",
              }}
            >
              {toneWord(insight.tone)}
            </Text>
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {insight.text}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
