/**
 * SendTimeCellDetail — the exact numbers behind one cell of the heatmap.
 *
 * The grid is a gestalt; this is the receipt. Every figure is printed with its
 * denominator visible, because a 60% open rate over eleven delivered messages
 * is not a finding and the screen must not let it look like one.
 *
 * Every value that was never measured prints an em-dash. `bucketMetric`
 * decides that, not this component — see lib/sendTimeAnalysis.
 */
import { Text, View } from "react-native";

import { Card } from "@/components/Card";
import { FONT } from "@/lib/fonts";
import {
  bucketDenominator,
  bucketMetric,
  type SendTimeBucket,
} from "@/lib/sendTimeAnalysis";
import {
  formatMetric,
  formatRate,
  localWindowLabel,
  utcWindowLabel,
} from "@/lib/sendTimeLabels";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Below this many delivered messages a rate is arithmetic, not evidence. */
export const THIN_EVIDENCE_THRESHOLD = 50;

function Figure({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View style={{ minWidth: 78, flexGrow: 1, flexBasis: "30%" }}>
      <Text
        {...typeCap("badgeSmall")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("badgeSmall"),
          fontFamily: FONT.medium,
          textTransform: "uppercase",
          letterSpacing: 0.6,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          fontFamily: FONT.semibold,
          marginTop: 2,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

export function SendTimeCellDetail({
  bucket,
  offsetMinutes,
}: {
  bucket: SendTimeBucket;
  offsetMinutes: number;
}) {
  const { t } = useTheme();
  const denominator = bucketDenominator(bucket);
  const openRate = bucketMetric(bucket, "openRate");
  const clickRate = bucketMetric(bucket, "clickRate");
  const thin = denominator > 0 && denominator < THIN_EVIDENCE_THRESHOLD;

  return (
    <Card style={{ gap: 12 }}>
      <View>
        <Text
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            fontFamily: FONT.semibold,
          }}
        >
          {localWindowLabel(bucket, offsetMinutes)}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 2,
          }}
        >
          {utcWindowLabel(bucket)} · your device&apos;s time above
        </Text>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        <Figure label="Sent" value={String(bucket.sent)} />
        <Figure label="Delivered" value={String(bucket.delivered)} />
        <Figure label="Opened" value={String(bucket.opened)} />
        <Figure label="Clicked" value={String(bucket.clicked)} />
        <Figure label="Open rate" value={formatRate(openRate)} />
        <Figure label="Click rate" value={formatRate(clickRate)} />
      </View>

      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: t.borderSubtle,
          paddingTop: 10,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {bucket.subscriberSignal > 0
            ? `${formatMetric(bucket.subscriberSignal, "signal")} subscribers are modelled to read at this hour.`
            : "No subscriber has this hour as their modelled best hour."}
        </Text>
        {denominator === 0 ? (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              marginTop: 6,
            }}
          >
            Nothing has been sent into this hour in this window, so there is no
            open or click rate to report — not a rate of zero.
          </Text>
        ) : null}
        {thin ? (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.warning,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.medium,
              marginTop: 6,
            }}
          >
            Only {denominator} messages landed in this hour. Rates this thin move
            several points on a single open.
          </Text>
        ) : null}
      </View>
    </Card>
  );
}
