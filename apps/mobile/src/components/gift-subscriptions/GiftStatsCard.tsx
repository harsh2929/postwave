/** Honest aggregate lifecycle summary for the Gift archive. */
import { Text, View } from "react-native";

import { EMDASH, num, percent, plural, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { conversionRate } from "@/lib/giftInsights";
import type { GiftHistoryStats } from "@/lib/giftSubscriptions";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export type GiftStatsCardState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; stats: GiftHistoryStats };

const STATUS_COPY = {
  loading: {
    badge: "Loading",
    busy: true,
    header: "Aggregate read loading.",
    tone: "info",
    unresolved: `Archive conversion ${EMDASH} · loading`,
    unresolvedSpoken: "Archive conversion is loading.",
  },
  ready: {
    badge: "Available",
    busy: false,
    header: "Aggregate read available.",
    tone: "success",
    unresolved: `Archive conversion ${EMDASH} · 0 resolved`,
    unresolvedSpoken:
      "Archive conversion cannot be calculated because no gifts have resolved.",
  },
  unavailable: {
    badge: "Unavailable",
    busy: false,
    header: "Aggregate read unavailable; counts are unknown, not zero.",
    tone: "warning",
    unresolved: `Archive conversion ${EMDASH} · unavailable`,
    unresolvedSpoken: "Archive conversion is unavailable.",
  },
} as const;

export function GiftStatsCard({
  state,
  now,
}: {
  state: GiftStatsCardState;
  now: number;
}) {
  const { t } = useTheme();
  const stats = state.status === "ready" ? state.stats : null;
  const rate = conversionRate(stats);
  const open = stats ? stats.pending + stats.paid : null;
  const presentation = STATUS_COPY[state.status];
  const tone = t[presentation.tone];
  const conversionSpoken = rate
    ? `Archive conversion rate ${percent(rate.rate)} across ${num(rate.resolved)} resolved gifts.`
    : presentation.unresolvedSpoken;
  const conversionText = rate
    ? `Archive conversion ${percent(rate.rate)} · ${num(rate.resolved)} resolved`
    : presentation.unresolved;
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 10,
      }}
    >
      <View
        accessible
        accessibilityLabel={`Archive statistics. ${presentation.header}`}
        accessibilityState={{ busy: presentation.busy }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.medium,
            }}
          >
            Archive snapshot
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              marginTop: 1,
            }}
          >
            Independent aggregate read
          </Text>
        </View>
        <View
          style={{
            minHeight: 28,
            justifyContent: "center",
            borderRadius: 999,
            borderWidth: 1,
            borderColor: tone,
            paddingHorizontal: 10,
          }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: tone,
              ...typeStyle("label"),
              fontFamily: FONT.medium,
            }}
          >
            {presentation.badge}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Figure
          label="Records"
          value={stats ? num(stats.total) : EMDASH}
          spoken={stats ? `${plural(stats.total, "record")} in total` : null}
          state={state.status}
        />
        <Figure
          label="Open"
          value={open === null ? EMDASH : num(open)}
          spoken={open === null ? null : `${plural(open, "gift")} still open`}
          state={state.status}
        />
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Figure
          label="Redeemed"
          value={stats ? num(stats.redeemed) : EMDASH}
          spoken={stats ? `${plural(stats.redeemed, "gift")} redeemed` : null}
          state={state.status}
        />
        <Figure
          label="Expired"
          value={stats ? num(stats.expired) : EMDASH}
          spoken={stats ? `${plural(stats.expired, "gift")} expired` : null}
          state={state.status}
        />
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Figure
          label="Cancelled"
          value={stats ? num(stats.cancelled) : EMDASH}
          spoken={stats ? `${plural(stats.cancelled, "gift")} cancelled` : null}
          state={state.status}
        />
        <Figure
          label="Refunded"
          value={stats ? num(stats.refunded) : EMDASH}
          spoken={stats ? `${plural(stats.refunded, "gift")} refunded` : null}
          state={state.status}
        />
      </View>

      <Text
        {...typeCap("caption")}
        accessibilityLabel={conversionSpoken}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {conversionText}
        {stats?.generatedAt
          ? ` · computed ${relativeTime(stats.generatedAt, { now })}`
          : ""}
      </Text>

      <StatsFootnote status={state.status} hasResolved={rate !== null} />
    </View>
  );
}

function StatsFootnote({
  status,
  hasResolved,
}: {
  status: GiftStatsCardState["status"];
  hasResolved: boolean;
}) {
  const { t } = useTheme();
  if (status === "loading") {
    return (
      <Text
        accessibilityLiveRegion="polite"
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        Loading archive statistics. Counts remain unknown until the aggregate
        read lands; archive records load independently.
      </Text>
    );
  }
  if (status === "unavailable") {
    return (
      <Text
        accessibilityLiveRegion="polite"
        {...typeCap("bodySmall")}
        style={{
          color: t.warning,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        Statistics are unavailable. Counts are unknown, not zero; pull to retry
        while the archive below remains an independent read.
      </Text>
    );
  }
  if (!hasResolved) {
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        No terminal gifts have resolved yet. Conversion will appear after a gift
        is redeemed, cancelled, expired or refunded.
      </Text>
    );
  }
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      Conversion follows the server&apos;s resolved-gift metric. Paid, pending
      and refunded records are not treated as redeemed.
    </Text>
  );
}

function Figure({
  label,
  value,
  spoken,
  state,
}: {
  label: string;
  value: string;
  spoken: string | null;
  state: "loading" | "unavailable" | "ready";
}) {
  const { t } = useTheme();
  const stateLabel =
    state === "loading"
      ? `${label} loading`
      : state === "unavailable"
        ? `${label} unavailable — unknown, not zero`
        : `${label} unavailable`;
  return (
    <View
      accessible
      accessibilityLabel={spoken ?? stateLabel}
      style={{
        flex: 1,
        backgroundColor: t.bgSubtle,
        borderRadius: 10,
        padding: 12,
      }}
    >
      <Text
        {...typeCap("figure")}
        numberOfLines={1}
        style={{
          color: t.fg,
          fontSize: 18,
          lineHeight: 22,
          fontWeight: "700",
          fontFamily: FONT.bold,
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginTop: 2,
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
