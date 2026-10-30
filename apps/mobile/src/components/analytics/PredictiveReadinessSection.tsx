/**
 * PredictiveReadinessSection — how much of the model you may believe, and what
 * shape the customer base is in.
 *
 * DASHBOARD#31. The Customer value card above states the model's OUTPUT. This
 * one states its COVERAGE, and it sits directly under it for that reason:
 * model output without provenance is the single most misleading thing a phone
 * can show, because a median customer value computed over 4% of a list is
 * visually identical to one computed over 96% of it.
 *
 * THE ZERO THAT IS NOT A ZERO. `GET /api/v1/predictive/data-sufficiency`
 * answers a workspace that has never been recomputed with a zeroed report and
 * HTTP 200 (apps/api/internal/predictive/repo.go:360). `parseDataSufficiency`
 * resolves that to null, and the copy for null says no snapshot exists — not
 * that coverage is 0%.
 *
 * WHY RFM IS BARS AND NOT A PIE. The question a phone asks of an RFM breakdown
 * is "which band is my biggest", which is a length comparison. A share is also
 * printed beside each bar so the ranking never depends on comparing widths,
 * and the spoken label carries the exact profile count.
 *
 * NativeWind v4: no Pressable on this card; every style object is static.
 */
import { Text, View } from "react-native";

import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { PredictiveRecomputeAction } from "@/components/analytics/PredictiveRecomputeAction";
import { SkeletonCard } from "@/components/Skeleton";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { dateTime, num, percent, plural } from "@/lib/format";
import {
  sufficiencyHeadline,
  type DataSufficiency,
  type RfmSegment,
} from "@/lib/predictiveReadiness";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface PredictiveReadinessSectionProps {
  query: QueryLike;
  sufficiency: DataSufficiency | null;
  segments: readonly RfmSegment[];
  gate: Pick<OnlineQueryGate, "enabled">;
}

export function PredictiveReadinessSection({
  query,
  sufficiency,
  segments,
  gate,
}: PredictiveReadinessSectionProps) {
  const { t } = useTheme();
  const copy = sufficiencyHeadline(sufficiency);
  const toneColor =
    copy.tone === "attention"
      ? t.warning
      : copy.tone === "ok"
        ? t.fg
        : t.fgMuted;

  return (
    <QueryStates
      query={query}
      // Never "empty": a workspace with no snapshot still has a sentence to
      // read, and it is the most important one on the card.
      isEmpty={false}
      gate={gate}
      skeleton={<SkeletonCard lines={4} />}
    >
      <View style={{ gap: 14 }}>
        <View
          accessible
          accessibilityLabel={`${copy.headline}. ${copy.detail}`}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: toneColor,
              fontFamily: FONT.semibold,
              ...typeStyle("callout"),
              fontVariant: ["tabular-nums"],
            }}
          >
            {copy.headline}
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              fontFamily: FONT.regular,
              ...typeStyle("caption"),
              marginTop: 4,
            }}
          >
            {copy.detail}
          </Text>
          {sufficiency?.lastUpdated ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                fontFamily: FONT.regular,
                ...typeStyle("caption"),
                marginTop: 4,
              }}
            >
              Coverage measured {dateTime(sufficiency.lastUpdated)}.
            </Text>
          ) : null}
        </View>

        {/* Directly under the coverage sentence it can change. The rollup this
            card reads is written ONLY by a recompute (predictive/repo.go:457),
            so "4% coverage, measured three weeks ago" was a fact a phone could
            read and not act on. Admin-gated by the route's own role; below it
            the control is replaced by the sentence that says why. */}
        <PredictiveRecomputeAction />

        {segments.length > 0 ? (
          <View>
            <Text
              accessibilityRole="header"
              {...typeCap("label")}
              style={{
                color: t.fg,
                fontFamily: FONT.bold,
                ...typeStyle("label"),
                marginBottom: 8,
              }}
            >
              Customer bands
            </Text>
            {segments.slice(0, 7).map((segment) => (
              <SegmentBar key={segment.key} segment={segment} />
            ))}
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                fontFamily: FONT.regular,
                ...typeStyle("caption"),
                marginTop: 10,
              }}
            >
              Recency / frequency / monetary bands, scored from paid commerce
              orders. Bands are assigned by the server, not chosen here.
            </Text>
          </View>
        ) : null}
      </View>
    </QueryStates>
  );
}

function SegmentBar({ segment }: { segment: RfmSegment }) {
  const { t } = useTheme();
  // "Insufficient data" is a real band and usually the largest one in a
  // workspace new to commerce. Muting it stops it reading as a customer
  // segment, without hiding it — its size is the point.
  const isAbsence = segment.key === "insufficient_data";
  return (
    <View
      accessible
      // The exact count travels with the compacted bar (house rule 4).
      accessibilityLabel={`${segment.label}: ${plural(segment.profiles, "profile")}, ${percent(segment.share, { digits: 0 })} of scored profiles`}
      style={{ marginBottom: 10 }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: isAbsence ? t.fgMuted : t.fg,
            fontFamily: FONT.regular,
            ...typeStyle("bodySmall"),
            flex: 1,
          }}
        >
          {segment.label}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
            fontVariant: ["tabular-nums"],
          }}
        >
          {num(segment.profiles)} · {percent(segment.share, { digits: 0 })}
        </Text>
      </View>
      <View
        // Decorative: every fact in this bar is already spoken by the row's
        // own accessibilityLabel.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          height: 6,
          borderRadius: 3,
          backgroundColor: t.borderSubtle,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            height: 6,
            borderRadius: 3,
            width: `${Math.max(2, Math.round(segment.share * 100))}%`,
            backgroundColor: isAbsence ? t.fgSubtle : t.accent,
          }}
        />
      </View>
    </View>
  );
}
