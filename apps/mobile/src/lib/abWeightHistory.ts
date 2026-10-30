/**
 * lib/abWeightHistory.ts — turning the bandit's allocation ledger into
 * something a line chart can draw, with no react-native import in sight.
 *
 * WHAT THE ENDPOINT ANSWERS. `GET /api/v1/campaigns/{id}/ab-weight-history`
 * returns `{campaign_id, series: [{variant_id, label, points:[{at, weight}]}]}`
 * (apps/api/internal/abtests/bandit.go:34-42). Each point is one recompute of
 * one arm's traffic share. A FIXED split writes no history at all, and a bandit
 * that has recomputed once writes a single point per arm.
 *
 * WHY A PURE MODULE. Three things here are genuinely easy to get wrong, and all
 * three are arithmetic rather than layout:
 *
 *  1. THE X AXIS IS SHARED, THE DATA IS NOT. `TimeSeriesChart` takes one label
 *     array and one values array per series, indexed in lockstep. The API
 *     returns each arm's own point list. They normally align — the scheduler
 *     recomputes every arm in one pass — but "normally" is not a contract: an
 *     arm added mid-test, or a recompute that failed for one arm, yields ragged
 *     lists. Zipping ragged lists by INDEX silently plots arm B's 11am weight
 *     at arm A's 9am tick. So the union of timestamps is the axis, and an arm
 *     with no point at a tick gets `null` — which the chart renders as a GAP,
 *     the honest answer, rather than interpolating a weight that was never
 *     recorded.
 *  2. WEIGHTS ARE FRACTIONS OR PERCENTAGES DEPENDING ON WHO WROTE THEM. The
 *     column is a float; the allocator stores 0..1. Plotting 0.42 on an axis
 *     labelled "%" is wrong by two orders of magnitude, so the scale is decided
 *     ONCE from the data (see `weightsLookFractional`) and applied to every
 *     series, never per point — a per-point guess would rescale one arm and not
 *     another and invent a crossover.
 *  3. ONE POINT IS NOT A TREND. The desktop guard is
 *     `weightHistory.some(s => s.points.length >= 2)`; anything less draws a
 *     flat line that says "the split never moved" when the truth is "we have
 *     not measured it moving". `readWeightHistory` reports `drifted` so the
 *     caller can hide the block entirely rather than assert something false.
 *
 * DELIBERATELY IMPORT-FREE, so it is testable in the node vitest environment.
 */

/** One recompute of one arm's share, as the gateway sends it. */
export interface WeightHistoryPointWire {
  at?: unknown;
  weight?: unknown;
}

/** One arm's allocation ledger, as the gateway sends it. */
export interface WeightHistorySeriesWire {
  variant_id?: unknown;
  label?: unknown;
  points?: unknown;
}

export interface WeightHistoryResponseWire {
  campaign_id?: unknown;
  series?: unknown;
}

/** A chart-ready arm: values are index-aligned to `ticks`, gaps are null. */
export interface WeightSeries {
  id: string;
  label: string;
  values: (number | null)[];
}

export interface WeightHistoryReading {
  /** Union of every arm's timestamps, ascending. One entry per x position. */
  ticks: number[];
  series: WeightSeries[];
  /**
   * True only when at least one arm has two or more recorded points — the
   * desktop's own guard. False means "do not draw this", not "nothing moved".
   */
  drifted: boolean;
  /** True when weights arrived as 0..1 and were scaled to percent for display. */
  scaledFromFraction: boolean;
}

export const EMPTY_WEIGHT_HISTORY: WeightHistoryReading = {
  ticks: [],
  series: [],
  drifted: false,
  scaledFromFraction: false,
};

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/** Accepts the RFC3339 string the Go `time.Time` marshals to, or epoch ms. */
function asTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * Are these weights fractions (0..1) rather than percentages?
 *
 * Decided over the WHOLE payload, because the answer must be the same for every
 * arm. A two-arm test sitting at exactly 0.5 / 0.5 and a two-arm test sitting
 * at 50 / 50 are the same allocation expressed differently, and the only signal
 * separating them is magnitude.
 *
 * The rule: if nothing exceeds 1, treat it as fractional. A genuine percentage
 * series that never exceeds 1% would be misread — but an arm allocated under 1%
 * of traffic on every recompute is not a case the bandit produces (the explore
 * floor keeps arms above it), whereas fractional storage is what the allocator
 * actually writes.
 */
export function weightsLookFractional(weights: readonly number[]): boolean {
  if (weights.length === 0) return false;
  return weights.every((w) => w <= 1);
}

/**
 * Normalise the wire payload into one shared time axis plus index-aligned
 * per-arm values, in percent.
 */
export function readWeightHistory(
  body: WeightHistoryResponseWire | null | undefined,
): WeightHistoryReading {
  const rawSeries = Array.isArray(body?.series)
    ? (body.series as WeightHistorySeriesWire[])
    : [];
  if (rawSeries.length === 0) return EMPTY_WEIGHT_HISTORY;

  // Pass 1: parse each arm into a timestamp→weight map, dropping unusable
  // points rather than letting a null crash the scale computation.
  const parsed: {
    id: string;
    label: string;
    byTick: Map<number, number>;
  }[] = [];
  const allTicks = new Set<number>();
  const allWeights: number[] = [];

  for (let i = 0; i < rawSeries.length; i++) {
    const arm = rawSeries[i];
    if (arm == null || typeof arm !== "object") continue;
    const points = Array.isArray(arm.points)
      ? (arm.points as WeightHistoryPointWire[])
      : [];
    const byTick = new Map<number, number>();
    for (const p of points) {
      if (p == null || typeof p !== "object") continue;
      const at = asTimestamp(p.at);
      const weight = asFiniteNumber(p.weight);
      if (at === null || weight === null || weight < 0) continue;
      // A duplicate timestamp for one arm means a re-recorded recompute; the
      // later value in document order wins, matching ORDER BY recorded_at.
      byTick.set(at, weight);
      allTicks.add(at);
      allWeights.push(weight);
    }
    if (byTick.size === 0) continue;
    const id =
      typeof arm.variant_id === "string" && arm.variant_id
        ? arm.variant_id
        : `arm-${i}`;
    const rawLabel = typeof arm.label === "string" ? arm.label.trim() : "";
    parsed.push({ id, label: rawLabel || `Variant ${i + 1}`, byTick });
  }

  if (parsed.length === 0) return EMPTY_WEIGHT_HISTORY;

  const ticks = [...allTicks].sort((a, b) => a - b);
  const scaledFromFraction = weightsLookFractional(allWeights);
  const factor = scaledFromFraction ? 100 : 1;

  const series: WeightSeries[] = parsed.map((arm) => ({
    id: arm.id,
    label: arm.label,
    values: ticks.map((tick) => {
      const w = arm.byTick.get(tick);
      return w === undefined ? null : w * factor;
    }),
  }));

  // The desktop guard: at least one arm must have moved through two recorded
  // points before this is a drift story rather than a single reading.
  const drifted = parsed.some((arm) => arm.byTick.size >= 2);

  return { ticks, series, drifted, scaledFromFraction };
}

/**
 * A one-sentence reading of where allocation ENDED UP, for the screen-reader
 * summary and the caption under the chart.
 *
 * The chart itself is the shape of the change; this is the part a person
 * actually repeats out loud ("it ended up sending 71% to Variant B").
 */
export function weightDriftSummary(reading: WeightHistoryReading): string | null {
  if (!reading.drifted || reading.series.length === 0) return null;
  const finals = reading.series
    .map((s) => {
      for (let i = s.values.length - 1; i >= 0; i--) {
        const v = s.values[i];
        if (typeof v === "number") return { label: s.label, value: v };
      }
      return null;
    })
    .filter((entry): entry is { label: string; value: number } => entry != null)
    .sort((a, b) => b.value - a.value);
  const top = finals[0];
  if (top === undefined) return null;
  const parts = finals.map((f) => `${f.label} ${Math.round(f.value)}%`);
  return `Traffic settled at ${parts.join(", ")}. ${top.label} is taking the largest share.`;
}
