/**
 * McpVerdictCard — the one sentence the agent-activity screen exists to
 * produce, with the four figures that qualify it.
 *
 * The judgement itself is in `lib/mcpActivity.mcpActivityVerdict` (pure,
 * node-tested); this component only paints it and adds the measurements.
 *
 * WHY THE FIGURES ARE EM-DASHES ON AN IDLE WINDOW. `Stats.SuccessRate`,
 * `AverageLatencyMs` and `P95LatencyMs` are the zero values of an aggregate
 * over an empty set — the Go code only assigns `SuccessRate` when
 * `TotalCalls > 0` (apikeycalls.go:374-376), and `AVG`/`PERCENTILE_DISC` are
 * COALESCEd to 0 (:357-358). Printing "0%" and "0 ms" for a window with no
 * calls would read as a total outage with instant responses, which is two
 * false statements at once. `stats.hasCalls` decides, and the tile shows an
 * em-dash otherwise.
 *
 * State is never colour alone: the tone is carried by a labelled Pill, and the
 * card's spoken label opens with the same headline.
 */
import { Text, View } from "react-native";

import { Pill, type PillTone } from "@/components/Pill";
import { EMDASH, money, num, percent } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import {
  mcpCostUnits,
  type McpStats,
  type McpVerdict,
  type McpVerdictTone,
} from "@/lib/mcpActivity";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const TONE_PILL: Readonly<Record<McpVerdictTone, PillTone>> = {
  ok: "success",
  warn: "warning",
  bad: "danger",
  idle: "neutral",
};

/** The word, so the state survives greyscale and colour-blindness. */
const TONE_WORD: Readonly<Record<McpVerdictTone, string>> = {
  ok: "all good",
  warn: "some failures",
  bad: "failing",
  idle: "quiet",
};

interface Figure {
  label: string;
  value: string;
  /** The full sentence a screen reader hears in place of the compacted value. */
  spoken: string;
}

function figures(stats: McpStats | null): Figure[] {
  if (!stats || !stats.hasCalls) {
    return [
      {
        label: "Recorded success rate",
        value: EMDASH,
        spoken:
          "Recorded success rate, not measured — no retained rows in this window",
      },
      {
        label: "p95 latency",
        value: EMDASH,
        spoken: "95th percentile latency, not measured",
      },
      {
        label: "Average latency",
        value: EMDASH,
        spoken: "Average latency, not measured",
      },
      {
        label: "Recorded cost estimate",
        value: EMDASH,
        spoken:
          "Recorded cost estimate, not measured; non-billing evidence only",
      },
    ];
  }
  const cost = mcpCostUnits(stats);
  return [
    {
      label: "Recorded success rate",
      value: percent(stats.successRate),
      spoken: `Recorded success rate ${percent(stats.successRate)}, counting any retained 2xx or 3xx row as a success. ${num(stats.successfulCalls)} of ${num(stats.totalCalls)} retained rows. Advisory only.`,
    },
    {
      label: "p95 latency",
      value: `${num(stats.p95LatencyMs)} ms`,
      spoken: `95th percentile latency, ${num(stats.p95LatencyMs)} milliseconds`,
    },
    {
      label: "Average latency",
      value: `${num(Math.round(stats.averageLatencyMs))} ms`,
      spoken: `Average latency, ${num(Math.round(stats.averageLatencyMs))} milliseconds`,
    },
    {
      label: "Recorded cost estimate",
      // `money` with cents: an agent window is routinely a fraction of a
      // dollar, and rounding it to $0 would erase the only number an operator
      // watching spend cares about.
      value: cost === null ? EMDASH : money(cost, "USD", { cents: true }),
      spoken:
        cost === null
          ? "Recorded cost estimate, not measured; non-billing evidence only"
          : `Recorded cost estimate ${money(cost, "USD", { cents: true })} across retained rows; advisory, non-billing evidence only`,
    },
  ];
}

export function McpVerdictCard({
  verdict,
  stats,
}: {
  verdict: McpVerdict;
  stats: McpStats | null;
}) {
  const { t } = useTheme();
  const rows = figures(stats);

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 12,
        gap: 12,
      }}
    >
      <View
        accessible
        accessibilityLabel={`${verdict.headline}. ${verdict.detail}`}
      >
        <Pill label={TONE_WORD[verdict.tone]} tone={TONE_PILL[verdict.tone]} />
        <Text
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            marginTop: 8,
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {verdict.headline}
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {verdict.detail}
        </Text>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {rows.map((row) => (
          <View
            key={row.label}
            accessible
            accessibilityLabel={row.spoken}
            style={{ minWidth: 120, flexGrow: 1, flexBasis: "44%" }}
          >
            <Text
              {...typeCap("badgeSmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("badgeSmall"),
                letterSpacing: 0.6,
                textTransform: "uppercase",
                fontFamily: FONT.semibold,
              }}
            >
              {row.label}
            </Text>
            <Text
              {...typeCap("numeric")}
              style={{
                color: t.fg,
                ...typeStyle("numeric"),
                marginTop: 2,
                fontVariant: ["tabular-nums"],
                fontFamily: FONT.semibold,
              }}
              numberOfLines={1}
            >
              {row.value}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
