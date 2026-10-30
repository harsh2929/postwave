/**
 * Lifetime stats, the 30-day engagement sparkline, and the two honest
 * notices for when the timeline endpoint is missing or failing.
 *
 * All three come from the /timeline payload, so they share one file and one
 * availability story.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";

import {
  Card,
  Label,
  MiniStat,
} from "@/components/subscriber/SubscriberDetailPrimitives";
import { Sparkline } from "@/components/charts/Sparkline";
import { FONT } from "@/lib/fonts";
import { num as fmtNum, percent as fmtPercent } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SubscriberTimelineStats {
  sent_count: number;
  opened_count: number;
  clicked_count: number;
  bounced_count: number;
  replied_count: number;
  open_rate: number;
  click_rate: number;
  engagement_score: number;
  engagement_daily_30d: number[];
  subscribed_at: string;
  last_active_at?: string;
  current_status: string;
}

export function SubscriberLifetimeStats({
  stats,
}: {
  stats: SubscriberTimelineStats;
}) {
  const { t } = useTheme();
  return (
    <View style={{ marginTop: 12 }}>
      <Label style={{ marginBottom: 8 }}>Lifetime activity</Label>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <MiniStat label="Sent" value={fmtNum(stats.sent_count)} t={t} />
        <MiniStat
          label="Opens"
          value={fmtNum(stats.opened_count)}
          sub={fmtPercent(stats.open_rate, { fallback: "" }) || null}
          t={t}
        />
        <MiniStat
          label="Clicks"
          value={fmtNum(stats.clicked_count)}
          sub={fmtPercent(stats.click_rate, { fallback: "" }) || null}
          t={t}
        />
        <MiniStat label="Bounces" value={fmtNum(stats.bounced_count)} t={t} />
        <MiniStat label="Replies" value={fmtNum(stats.replied_count)} t={t} />
      </View>
    </View>
  );
}

export function SubscriberEngagementSpark({
  daily,
}: {
  daily: number[] | undefined;
}) {
  const [width, setWidth] = useState<number | null>(null);
  const values = useMemo(() => {
    if (!Array.isArray(daily)) return [];
    const clean = daily.map((v) =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0,
    );
    // All-zero is "no data yet", not a flat line at zero.
    return clean.some((v) => v > 0) ? clean : [];
  }, [daily]);

  const onLayout = (e: LayoutChangeEvent) => {
    const inner = Math.max(0, Math.round(e.nativeEvent.layout.width - 32));
    if (inner > 0 && inner !== width) setWidth(inner);
  };

  return (
    <Card style={{ marginTop: 12 }} onLayout={onLayout}>
      <Sparkline
        values={values}
        label="30-day engagement"
        width={width ?? 300}
        height={56}
      />
    </Card>
  );
}

/** The deployment has no /timeline endpoint at all (404/405/501). */
export function TimelineUnavailableCard({
  onBackToSubscribers,
}: {
  onBackToSubscribers: () => void;
}) {
  const { t } = useTheme();
  return (
    <Card style={{ marginTop: 12 }}>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        Activity timeline unavailable. The drill-down endpoint isn&apos;t
        reachable on this deployment.
      </Text>
      <Pressable
        onPress={onBackToSubscribers}
        accessibilityRole="button"
        accessibilityLabel="Back to subscribers"
        style={{
          marginTop: 10,
          alignSelf: "flex-start",
          paddingVertical: 8,
          paddingHorizontal: 14,
          minHeight: 44,
          justifyContent: "center",
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: "transparent",
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Back to subscribers
        </Text>
      </Pressable>
    </Card>
  );
}

/** The endpoint exists but the request failed — retryable, and honest about
 *  whether the problem is the network or the server. */
export function TimelineErrorCard({
  isOnline,
  isFetching,
  onRetry,
}: {
  isOnline: boolean;
  isFetching: boolean;
  onRetry: () => void;
}) {
  const { t } = useTheme();
  return (
    <Card>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.danger,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {isOnline
          ? "Couldn't load the activity timeline."
          : "You're offline — the activity timeline needs a connection."}
      </Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Retry loading activity timeline"
        disabled={isFetching}
        style={{
          marginTop: 12,
          alignSelf: "flex-start",
          paddingVertical: 8,
          paddingHorizontal: 14,
          minHeight: 44,
          justifyContent: "center",
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: "transparent",
          opacity: isFetching ? 0.6 : 1,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {isFetching ? "Retrying…" : "Retry"}
        </Text>
      </Pressable>
    </Card>
  );
}
