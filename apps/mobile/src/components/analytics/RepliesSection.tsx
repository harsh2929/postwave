/**
 * RepliesSection — workspace reply intelligence on the Analytics screen.
 *
 * Before this section the phone could read ONE campaign's reply feed at a time
 * (campaigns/[id] → Replies card) and nothing workspace-level: no volume, no
 * trend, no "who writes back". The desktop answers all three in its
 * ConversationsPanel; this is the phone translation — a headline, a trend
 * line and the ranked responder list, in one card.
 *
 * SELF-CONTAINED like LifecycleSection: owns its three queries via
 * useReplyAnalytics rather than threading them through useAnalyticsScreen, so
 * the screen's mount stays one line inside its own CardBoundary. The SUMMARY
 * is the primary read and owns the ladder (loading / error / offline / absent
 * / data); the trend and the responders are secondary, and each fails or
 * loads on its own line without taking the headline down.
 *
 * WINDOW-AWARE, unlike the platform reads beside it: /replies/* accept `days`
 * and honour it, so this section follows the screen's reporting window and
 * says so in its caption.
 *
 * The responder list prints recipient EMAILS — the fact the card exists for.
 * Its rows are rendered here rather than through the campaign insight list so
 * the section has no cross-domain dependency, and so a render test sees the
 * addresses instead of a stubbed component.
 */
import { Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonCard } from "@/components/Skeleton";
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  useReplySummary,
  useReplyTimeseries,
  useReplyTopSenders,
} from "@/hooks/useReplyAnalytics";
import { FONT } from "@/lib/fonts";
import { date } from "@/lib/format";
import {
  REPLIES_ABSENT_COPY,
  REPLIES_OFFLINE_COPY,
  REPLIES_SUBTITLE,
  REPLIES_TITLE,
  replyHeadline,
  replyProvenanceCaption,
  replyTrend,
  replyWindowCaption,
  replyWindowDays,
  TOP_SENDERS_CAPTION,
  TOP_SENDERS_TITLE,
  topSenderRows,
  TREND_TITLE,
  type ResponderRow,
} from "@/lib/replyAnalytics";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface RepliesSectionProps {
  /** The screen's reporting window token ("7d" | "30d" | "90d"). */
  range: string;
  /** The same window, spelled out ("Last 30 days") for the caption. */
  rangeLabel: string;
  gate: Pick<OnlineQueryGate, "enabled">;
}

export function RepliesSection({ range, rangeLabel, gate }: RepliesSectionProps) {
  const { t } = useTheme();
  const days = replyWindowDays(range);
  const summary = useReplySummary(days);
  const timeseries = useReplyTimeseries(days);
  const senders = useReplyTopSenders(days);

  if (summary.isLoading) {
    return (
      <Frame>
        <View accessibilityLabel="Loading replies">
          <SkeletonCard lines={4} />
        </View>
      </Frame>
    );
  }

  if (summary.isError) {
    return (
      <Frame>
        <ErrorState
          error={summary.error}
          onRetry={() => void summary.refetch()}
          compact
        />
      </Frame>
    );
  }

  if (summary.data === undefined) {
    // The query never ran. Offline with nothing cached gets its own sentence;
    // online with no tenant (signed out mid-scroll) gets nothing, because the
    // screen-level notice owns that state.
    if (gate.enabled) return null;
    return (
      <Frame>
        <Note color={t.fgMuted} text={REPLIES_OFFLINE_COPY} />
      </Frame>
    );
  }

  if (summary.data === null) {
    return (
      <Frame>
        <Note color={t.fgMuted} text={REPLIES_ABSENT_COPY} />
      </Frame>
    );
  }

  const reading = summary.data;
  const headline = replyHeadline(reading);
  const provenance = replyProvenanceCaption(reading);

  return (
    <Frame>
      <View
        style={{
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          padding: 14,
          gap: 12,
        }}
      >
        <View accessible accessibilityLabel={headline}>
          <Text
            {...typeCap("callout")}
            style={{
              color: t.fg,
              fontFamily: FONT.semibold,
              ...typeStyle("callout"),
              fontVariant: ["tabular-nums"],
            }}
          >
            {headline}
          </Text>
          {provenance ? <Note color={t.fgMuted} text={provenance} /> : null}
        </View>

        {/* Under an empty headline neither block has anything honest to add:
            a flat line of zeros and an empty ranking are noise. */}
        {reading.total > 0 ? (
          <>
            <TrendBlock query={timeseries} total={reading.total} t={t} />
            <RespondersBlock query={senders} t={t} />
          </>
        ) : null}

        <Note color={t.fgSubtle} text={replyWindowCaption(rangeLabel)} />
      </View>
    </Frame>
  );
}

/** The section's chrome in every state, so the title never disappears. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 24 }}>
      <SectionLabel subtitle={REPLIES_SUBTITLE}>{REPLIES_TITLE}</SectionLabel>
      {children}
    </View>
  );
}

function TrendBlock({
  query,
  total,
  t,
}: {
  query: ReturnType<typeof useReplyTimeseries>;
  total: number;
  t: ThemeTokens;
}) {
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        compact
      />
    );
  }
  // Nothing to say until there is data: printing "no daily counts were
  // reported" while the request is in flight would be a false sentence.
  if (query.data === undefined) {
    return query.isLoading ? (
      <View accessibilityLabel="Loading reply trend">
        <SkeletonCard lines={2} />
      </View>
    ) : null;
  }
  const trend = replyTrend(Array.isArray(query.data) ? query.data : [], total);
  if (trend.kind === "none") return null;
  if (trend.kind === "insufficient") {
    return <Note color={t.fgMuted} text={trend.message} />;
  }
  return (
    <TimeSeriesChart
      series={[{ id: "replies", label: "Replies", values: trend.values }]}
      labels={trend.labels}
      title={TREND_TITLE}
      height={140}
      valueNoun="replies"
    />
  );
}

function RespondersBlock({
  query,
  t,
}: {
  query: ReturnType<typeof useReplyTopSenders>;
  t: ThemeTokens;
}) {
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        compact
      />
    );
  }
  if (query.data === undefined) {
    return query.isLoading ? (
      <View accessibilityLabel="Loading top responders">
        <SkeletonCard lines={3} />
      </View>
    ) : null;
  }
  const rows = topSenderRows(Array.isArray(query.data) ? query.data : []);
  if (rows.length === 0) return null;
  return (
    <View style={{ gap: 10 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("label")}
        style={{
          color: t.fg,
          fontFamily: FONT.bold,
          ...typeStyle("label"),
        }}
      >
        {TOP_SENDERS_TITLE}
      </Text>
      {rows.map((row) => (
        <ResponderRowView key={row.key} row={row} t={t} />
      ))}
      <Note color={t.fgSubtle} text={TOP_SENDERS_CAPTION} />
    </View>
  );
}

/** One responder: address + count, a share bar, and when they last wrote. */
function ResponderRowView({ row, t }: { row: ResponderRow; t: ThemeTokens }) {
  const when = row.lastAt ? date(row.lastAt) : null;
  return (
    <View
      accessible
      accessibilityLabel={when ? `${row.spoken}, last on ${when}` : row.spoken}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          numberOfLines={1}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
            flexShrink: 1,
          }}
        >
          {row.email}
        </Text>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
        >
          {row.countLabel}
        </Text>
      </View>
      <View
        style={{
          marginTop: 4,
          height: 6,
          borderRadius: 3,
          backgroundColor: t.surface,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            width: `${Math.round(row.share * 100)}%`,
            height: "100%",
            borderRadius: 3,
            backgroundColor: t.accent,
          }}
        />
      </View>
      {when ? <Note color={t.fgSubtle} text={`Last reply ${when}`} /> : null}
    </View>
  );
}

function Note({ color, text }: { color: string; text: string }) {
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color,
        fontFamily: FONT.regular,
        ...typeStyle("caption"),
        marginTop: 2,
      }}
    >
      {text}
    </Text>
  );
}
