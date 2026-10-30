/**
 * SuppressionTrendHeader — the derivative, not just the level.
 *
 * The screen's entire summary used to be a header subtitle ("N suppressed").
 * The number that starts an investigation is "complaints tripled this week",
 * and it is one already-implemented, zero-filled endpoint away
 * (GET /api/v1/suppressions/trend). Rendered above the list as a stat row plus
 * a 30-day series.
 *
 * The chart carries a text summary because a line with no alternative text is
 * invisible to a screen reader.
 *
 * AN ABSENT TREND IS UNKNOWN, NOT ZERO. `useSuppressionTrend` is gated on
 * `gate.enabled && tenantId`, so offline it is DISABLED — neither loading nor
 * errored, `data` undefined — and a failed fetch lands in the same shape. The
 * three trend-derived tiles used to coerce that with `?? 0`, so a compliance
 * screen answered "0 new this week · 0 bounces · 0 complaints" for a
 * measurement it had never taken. Em-dash instead: this is the same rule the
 * audit-sinks and migrations counters follow.
 */
import { View } from "react-native";

import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import { StatCard } from "@/components/StatCard";
import { compactNum, exact, num } from "@/lib/format";
import {
  trendReasonTotals,
  type SuppressionTrend,
} from "@/lib/suppressionContracts";

export interface SuppressionTrendHeaderProps {
  trend: SuppressionTrend | undefined;
  /** Server-reported total suppressions (the level, not the flow). */
  total: number;
  loading: boolean;
}

/**
 * Reasons rolled into the two buckets an operator acts on differently.
 *
 * Returns `undefined` — not 0 — when there is no trend to split, so the caller
 * cannot accidentally render "no bounces" for "we never asked".
 */
function splitReasons(trend: SuppressionTrend | undefined): {
  bounces: number | undefined;
  complaints: number | undefined;
} {
  if (!trend) return { bounces: undefined, complaints: undefined };
  let bounces = 0;
  let complaints = 0;
  for (const { reason, count } of trendReasonTotals(trend)) {
    if (reason.includes("bounce")) bounces += count;
    else if (reason.includes("complaint") || reason.includes("spam")) {
      complaints += count;
    }
  }
  return { bounces, complaints };
}

/** Spoken value for a tile whose figure was never measured. */
const UNMEASURED = "not available";

export function SuppressionTrendHeader({
  trend,
  total,
  loading,
}: SuppressionTrendHeaderProps) {
  const { bounces, complaints } = splitReasons(trend);
  const points = trend?.points ?? [];
  const values = points.map((p) => p.count);
  const labels = points.map((p) => p.date.slice(5));

  return (
    <View style={{ gap: 12, marginBottom: 12 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <StatCard
          label="Suppressed"
          value={compactNum(total)}
          exact={exact(total, "suppressions")}
          numeric={total}
          loading={loading}
          style={{ flex: 1 }}
        />
        <StatCard
          label="New · 7d"
          // `compactNum(undefined)` is already an em-dash — the coercion to 0
          // was the only thing turning "not fetched" into a clean number.
          value={compactNum(trend?.last7)}
          exact={
            trend
              ? exact(trend.last7, "new suppressions in the last 7 days")
              : UNMEASURED
          }
          numeric={trend?.last7}
          loading={loading}
          style={{ flex: 1 }}
        />
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <StatCard
          label={`Bounces · ${trend?.days ?? 30}d`}
          value={compactNum(bounces)}
          exact={bounces === undefined ? UNMEASURED : exact(bounces, "bounces")}
          numeric={bounces}
          loading={loading}
          style={{ flex: 1 }}
        />
        <StatCard
          label={`Complaints · ${trend?.days ?? 30}d`}
          value={compactNum(complaints)}
          exact={
            complaints === undefined
              ? UNMEASURED
              : exact(complaints, "complaints")
          }
          numeric={complaints}
          loading={loading}
          style={{ flex: 1 }}
        />
      </View>
      {values.length > 1 ? (
        // TimeSeriesChart owns its own spoken summary (see chartSummary), so
        // the caller must not wrap it in a second accessibility group.
        <TimeSeriesChart
          series={[{ id: "added", label: "Added", values }]}
          labels={labels}
          title={`Added · last ${num(trend?.days ?? values.length)} days`}
          area
          zeroBased
          valueNoun="suppression"
        />
      ) : null}
    </View>
  );
}
