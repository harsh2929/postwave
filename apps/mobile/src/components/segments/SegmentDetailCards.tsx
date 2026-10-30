/**
 * The three cards of the segment detail screen.
 *
 * Two honesty rules are encoded here rather than in the route file:
 *
 *  - `lastCount` is a POINTER server-side. Absent means "never evaluated",
 *    not "matches nobody", so the size renders as "—  not evaluated yet"
 *    rather than a confident 0.
 *  - The size-history endpoint returns a single live point (plus a `note`)
 *    when the deployment has no `segment_size_history` table. Drawing that
 *    as a trend line would be a fabrication, so the chart needs ≥ 2 points
 *    and the server's note is rendered verbatim.
 */
import { Pressable, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { Pill } from "@/components/Pill";
import { SkeletonDetail } from "@/components/Skeleton";
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import { Card, Label } from "@/components/subscriber/SubscriberDetailPrimitives";
import type { MobileSegment, SegmentSizeHistory } from "@/api/segments";
import { FONT } from "@/lib/fonts";
import { date as fmtDate, num, plural, relativeTime } from "@/lib/format";
import { describeSegmentAst } from "@/lib/segmentAst";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * The card renders "Last sized 3 days ago" — or "not evaluated yet" — as its
 * headline fact, and until now that fact was read-only. An operator could see
 * the number was stale and had no way to make it current, even though
 * `POST /api/v1/segments/{id}/recompute` runs the recount synchronously.
 *
 * `onRecompute` is null below editor, matching the route's `write:subscribers`
 * floor, so nobody is offered a control that can only 403.
 */
export function SegmentSummaryCard({
  segment,
  onRecompute,
  recomputing = false,
}: {
  segment: MobileSegment;
  onRecompute?: (() => void) | null;
  recomputing?: boolean;
}) {
  const { t } = useTheme();
  const evaluated = segment.lastCount != null;
  return (
    <Card>
      <Label>Audience</Label>
      <View
        style={{
          flexDirection: "row",
          alignItems: "baseline",
          gap: 8,
          marginTop: 6,
        }}
      >
        <Text
          accessibilityLabel={
            evaluated
              ? plural(segment.lastCount, "member")
              : "Size not evaluated yet"
          }
          // The hero figure of this screen: `figure`'s 30pt size and its
          // 1.25x ceiling, because it shares a baseline-aligned row with the
          // "members" noun beside it.
          {...typeCap("figure")}
          style={{
            color: evaluated ? t.fg : t.fgSubtle,
            ...typeStyle("figure"),
            fontWeight: "700",
            fontFamily: FONT.display,
            fontVariant: ["tabular-nums"],
          }}
        >
          {evaluated ? num(segment.lastCount) : "—"}
        </Text>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {evaluated ? "members" : "not evaluated yet"}
        </Text>
      </View>
      {segment.lastEvaluatedAt ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            marginTop: 4,
            fontFamily: FONT.regular,
          }}
        >
          Last sized {relativeTime(segment.lastEvaluatedAt, { fallback: "—" })}
        </Text>
      ) : null}
      {onRecompute ? (
        <Pressable
          onPress={onRecompute}
          disabled={recomputing}
          accessibilityRole="button"
          accessibilityLabel={
            evaluated ? "Refresh this segment's size" : "Size this segment now"
          }
          accessibilityState={{ disabled: recomputing, busy: recomputing }}
          // NativeWind v4: static style object only.
          style={{ minHeight: 44, justifyContent: "center", marginTop: 4 }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: recomputing ? t.fgSubtle : t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {recomputing
              ? "Sizing…"
              : evaluated
                ? "Refresh size"
                : "Size it now"}
          </Text>
        </Pressable>
      ) : null}
      {segment.description ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          {segment.description}
        </Text>
      ) : null}
      <View
        style={{ flexDirection: "row", gap: 8, marginTop: 10, flexWrap: "wrap" }}
      >
        {segment.isTemplate ? <Pill label="From template" tone="info" /> : null}
        {segment.createdAt ? (
          <Pill label={`Created ${fmtDate(segment.createdAt)}`} tone="neutral" />
        ) : null}
      </View>
    </Card>
  );
}

export function SegmentRuleCard({ queryAst }: { queryAst: unknown }) {
  const { t } = useTheme();
  // Bounded, non-throwing walk — the tree is untrusted (it can be
  // LLM-authored via /segments/compile-from-text).
  const lines = describeSegmentAst(queryAst);
  return (
    <Card>
      <Label>Rule</Label>
      <View style={{ marginTop: 8, gap: 2 }}>
        {lines.map((line, i) => (
          <Text
            key={`${line.depth}-${i}-${line.text}`}
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              marginStart: line.depth * 14,
            }}
          >
            {line.text}
          </Text>
        ))}
      </View>
    </Card>
  );
}

export function SegmentSizeCard({
  history,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  history: SegmentSizeHistory | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const { t } = useTheme();
  const series = history?.series ?? [];
  return (
    <Card>
      <Label>Size over time</Label>
      {isLoading ? (
        <View style={{ marginTop: 8 }}>
          <SkeletonDetail sections={1} />
        </View>
      ) : isError ? (
        <View style={{ marginTop: 8 }}>
          <ErrorState error={error} onRetry={onRetry} />
        </View>
      ) : series.length >= 2 ? (
        <View style={{ marginTop: 8 }}>
          <TimeSeriesChart
            title="Segment size"
            labels={series.map((p) => fmtDate(p.at, p.at))}
            series={[
              {
                id: "size",
                label: "Members",
                values: series.map((p) => p.count),
              },
            ]}
            area
            valueNoun="members"
          />
        </View>
      ) : (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("bodySmall"),
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          Not enough history to draw a trend yet.
        </Text>
      )}
      {history?.note ? (
        // The server's own honesty flag, verbatim.
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          {history.note}
        </Text>
      ) : null}
    </Card>
  );
}
