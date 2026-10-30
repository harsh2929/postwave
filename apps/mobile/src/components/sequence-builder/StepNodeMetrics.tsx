/**
 * StepNodeMetrics — reach / opens / clicks for one step on the canvas.
 *
 * Split out of StepNode so that file stays under its line ceiling, and because
 * this is the only part of a step tile that renders MEASUREMENTS rather than
 * configuration — a different kind of claim, with a different failure mode.
 *
 * TWO RULES IT KEEPS.
 *
 * 1. Three bare integers in a row are meaningless to VoiceOver and ambiguous
 *    to everyone else, so the group carries one spoken sentence with the nouns
 *    attached and each number keeps its visible label.
 *
 * 2. ABSENCE IS NOT ZERO. `MetricCell` used to coerce a non-finite or missing
 *    count to `0`, which turns "the funnel report has no row for this field"
 *    into the confident and different claim "nobody reached this step". These
 *    rows come from `sequence_funnel_events`, which nothing in the repository
 *    writes today, so a partial payload is the EXPECTED shape rather than an
 *    edge case. A missing measurement now renders an em-dash and says "not
 *    measured" out loud.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { funnelMetricSpoken, type FunnelStepRow } from "@/lib/sequenceFunnel";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** The glyph for "we have no measurement", never for "the measurement is 0". */
const NOT_MEASURED = "—";

export function StepMetrics({ row }: { row: FunnelStepRow }) {
  const { t } = useTheme();
  const dropoff =
    typeof row.dropoff_pct === "number" && row.dropoff_pct > 0
      ? Math.round(row.dropoff_pct)
      : null;
  return (
    <View
      accessible
      accessibilityLabel={`${funnelMetricSpoken(row)}${dropoff !== null ? ` ${dropoff} percent did not reach this step.` : ""}`}
      style={{ flexDirection: "row", gap: 14, marginTop: 8, flexWrap: "wrap" }}
    >
      <MetricCell label="Reached" value={row.reached} />
      <MetricCell label="Opened" value={row.opened} />
      <MetricCell label="Clicked" value={row.clicked} />
      {dropoff !== null ? (
        <Text
          {...typeCap("badgeSmall")}
          style={{
            color: t.warning,
            ...typeStyle("badgeSmall"),
            fontFamily: FONT.medium,
            alignSelf: "center",
          }}
        >
          −{dropoff}% here
        </Text>
      ) : null}
    </View>
  );
}

function MetricCell({ label, value }: { label: string; value: number }) {
  const { t } = useTheme();
  const measured = typeof value === "number" && Number.isFinite(value);
  const safe = measured ? Math.max(0, Math.trunc(value)) : null;
  return (
    <View
      accessible
      accessibilityLabel={
        safe === null ? `${label}: not measured` : `${label}: ${safe}`
      }
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: safe === null ? t.fgSubtle : t.fg,
          ...typeStyle("callout"),
          fontFamily: FONT.semibold,
          fontVariant: ["tabular-nums"],
        }}
      >
        {safe === null ? NOT_MEASURED : safe}
      </Text>
      <Text
        {...typeCap("badgeSmall")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("badgeSmall"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
