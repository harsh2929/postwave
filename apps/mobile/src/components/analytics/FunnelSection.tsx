/**
 * FunnelSection — signup → first purchase → repeat purchase.
 *
 * A vertical stack of proportional bars is one of the few analytics shapes a
 * phone renders BETTER than a desktop: each stage gets a full line of readable
 * label, and the shrinking bar reads as a funnel without any of the trapezoid
 * geometry that makes desktop funnels hard to compare.
 *
 * THREE THINGS THIS CARD REFUSES TO DO, each of which the naive version does:
 *
 *  - It does not draw a workspace with no store as a collapse. See
 *    `funnelUnavailableReason`: a payload of `signup: N, first: 0, repeat: 0`
 *    is what every workspace without commerce orders receives, and rendering
 *    that shape is a picture of a business that lost all its customers.
 *  - It does not size bars from each stage's own conversion rate. Widths are a
 *    share of SIGNUP, so a stage at 2% of signups cannot look wide because the
 *    stage above it was also small.
 *  - It does not claim the screen's reporting window applies. The server
 *    buckets by signup MONTH, so the caption names its own window.
 *
 * NativeWind v4: every style object here is static (house rule 1) — there is
 * no Pressable on this card at all, because a funnel stage has nowhere to
 * drill into on the phone.
 */
import { Text, View } from "react-native";

import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { CohortFunnelDetail } from "@/components/analytics/CohortFunnelDetail";
import { SkeletonCard } from "@/components/Skeleton";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { chartPalette } from "@/lib/chartPalette";
import { FONT } from "@/lib/fonts";
import { EMDASH, num, percent } from "@/lib/format";
import {
  FUNNEL_BASE_STAGE,
  funnelBarSpoken,
  funnelBars,
  funnelBaseCount,
  funnelUnavailableReason,
  funnelWindowLabel,
  type SubscriberFunnel,
} from "@/lib/subscriberFunnel";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface FunnelSectionProps {
  query: QueryLike;
  funnel: SubscriberFunnel;
  gate: Pick<OnlineQueryGate, "enabled">;
  /** Months of signup cohorts requested — the server reads `weeks` as months. */
  months: number;
}

export function FunnelSection({
  query,
  funnel,
  gate,
  months,
}: FunnelSectionProps) {
  const { t, theme } = useTheme();
  const palette = chartPalette(theme);
  const reason = funnelUnavailableReason(funnel);
  const base = funnelBaseCount(funnel);
  const bars = funnelBars(funnel);

  return (
    <QueryStates
      query={query}
      isEmpty={funnel.steps.length === 0}
      gate={gate}
      skeleton={<SkeletonCard lines={4} />}
      empty={{
        title: "No funnel yet",
        description:
          "The signup-to-purchase funnel appears once this workspace has a signup month behind it.",
      }}
    >
      {reason ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            fontFamily: FONT.regular,
            ...typeStyle("bodySmall"),
          }}
        >
          {reason}
        </Text>
      ) : (
        <View style={{ gap: 14 }}>
          {bars.map((bar, index) => (
            <View
              key={bar.stage}
              accessible
              accessibilityLabel={funnelBarSpoken(bar, base)}
            >
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <Text
                  {...typeCap("label")}
                  numberOfLines={2}
                  style={{
                    color: t.fg,
                    fontFamily: FONT.medium,
                    ...typeStyle("label"),
                    flexShrink: 1,
                  }}
                >
                  {bar.label}
                </Text>
                <Text
                  {...typeCap("numeric")}
                  style={{
                    color: t.fg,
                    fontFamily: FONT.semibold,
                    ...typeStyle("numeric"),
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {bar.count === null ? EMDASH : num(bar.count)}
                </Text>
              </View>
              {/* The track is always drawn at full width so the shrinking fill
                  reads against a constant reference; a bar with no track is a
                  length the eye has nothing to measure. */}
              <View
                style={{
                  height: 10,
                  borderRadius: 5,
                  backgroundColor: t.borderSubtle,
                  marginTop: 6,
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    width: `${bar.widthPct}%`,
                    height: "100%",
                    borderRadius: 5,
                    // Bound to the stage's POSITION, not to its rank: the same
                    // stage keeps the same colour whatever the numbers do.
                    backgroundColor: palette.seriesColor(index),
                  }}
                />
              </View>
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgMuted,
                  fontFamily: FONT.regular,
                  ...typeStyle("caption"),
                  marginTop: 4,
                }}
              >
                {stageCaption(bar.stage, bar.count, base, bar.conversionPct)}
              </Text>
            </View>
          ))}

          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              fontFamily: FONT.regular,
              ...typeStyle("caption"),
            }}
          >
            {`${funnelWindowLabel(months, funnel.cohortCount)} A subscriber counts as a purchaser when a paid order is matched to their email address at or after they signed up, so the reporting window above does not apply.`}
          </Text>

          {/* The per-cohort breakdown and the tag-audience filter, both of
              which the aggregate above cannot carry. Mounted only in the
              drawable branch: a workspace whose `reason` says no paid order is
              matched has already been told why, and a table of zeroed purchase
              columns would repeat it twelve times. */}
          <CohortFunnelDetail months={months} />
        </View>
      )}
    </QueryStates>
  );
}

/**
 * The line under each bar. The first stage is the denominator, so saying "100%
 * of signups" beneath it is noise; every later stage states BOTH denominators,
 * because the server's own rate is against the previous stage and a reader who
 * assumes it is against signups will overstate the bottom of the funnel by a
 * factor of several.
 */
function stageCaption(
  stage: string,
  count: number | null,
  base: number | null,
  conversionPct: number | null,
): string {
  if (count === null) return "Not reported";
  if (stage === FUNNEL_BASE_STAGE) return "Everyone who joined in the window";
  const share =
    base === null || base <= 0
      ? EMDASH
      : percent(count / base, { digits: 1 });
  const step =
    conversionPct === null
      ? EMDASH
      : percent(conversionPct, { alreadyPercent: true, digits: 1 });
  return `${share} of signups · ${step} of the stage above`;
}
