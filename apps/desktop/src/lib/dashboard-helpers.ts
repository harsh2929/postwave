/**
 * Pure helpers for the refined Dashboard. No I/O, no React — fully
 * unit-testable. Lives here (not co-located with components) so the
 * Vitest suite can import without React state in the loader path.
 *
 * Used by: components/dashboard/StatCard, components/dashboard/Sparkline,
 * pages/Dashboard.
 */

export type DeltaMode = "count" | "percent-points";

export interface DeltaResult {
  /** "up" for increase, "down" for decrease, "flat" when the change is
   *  too small to matter (< 0.5 in count mode, < 0.05 pp in pp mode). */
  dir: "up" | "down" | "flat";
  /** Human-readable formatted delta, e.g. "+148" or "-1.2pt" or "—". */
  text: string;
}

/**
 * Format a period-over-period delta for display. Returns "—" when
 * `prev` is null/undefined OR when delta rounds to zero.
 *
 * In 'percent-points' mode BOTH inputs MUST be 0–1 fractions (the
 * shape rateFromCounts returns). No per-value scale guessing — the
 * old `v > 1 ? v : v*100` heuristic could normalise curr and prev on
 * different scales and fabricate deltas like "+93.5pt".
 *
 *   formatDelta(2500, 2352, 'count')           → { dir: 'up',  text: '+148'  }
 *   formatDelta(0.224, 0.212, 'percent-points')→ { dir: 'up',  text: '+1.2pt'}
 *   formatDelta(10, 10, 'count')               → { dir: 'flat',text: '—'    }
 *   formatDelta(5, null, 'count')              → { dir: 'flat',text: '—'    }
 */
export function formatDelta(
  curr: number,
  prev: number | null | undefined,
  mode: DeltaMode,
): DeltaResult {
  if (
    typeof prev !== "number" ||
    !Number.isFinite(prev) ||
    !Number.isFinite(curr)
  ) {
    return { dir: "flat", text: "—" };
  }
  if (mode === "count") {
    const delta = curr - prev;
    if (Math.abs(delta) < 0.5) return { dir: "flat", text: "—" };
    const dir = delta > 0 ? "up" : "down";
    const sign = delta > 0 ? "+" : "";
    return {
      dir,
      text: `${sign}${Math.round(delta).toLocaleString()}`,
    };
  }
  // percent-points: inputs are 0..1 fractions; convert once to points.
  const delta = (curr - prev) * 100;
  if (Math.abs(delta) < 0.05) return { dir: "flat", text: "—" };
  const dir = delta > 0 ? "up" : "down";
  const sign = delta > 0 ? "+" : "";
  return { dir, text: `${sign}${delta.toFixed(1)}pt` };
}

export interface SparklinePath {
  /** SVG `d` for the stroke line, e.g. "M0,28 L18,12 …". */
  line: string;
  /** SVG `d` for the filled area beneath the line. */
  area: string;
  /** Coords of the final point — useful for a terminal dot. */
  lastX: number;
  lastY: number;
}

/**
 * Map an array of numeric values into an SVG path string sized to
 * (width × height). Always yields a valid path even for empty or
 * all-zero inputs (a flat line at the baseline). `padding` reserves
 * pixels at the top so the highest point doesn't kiss the edge.
 *
 *   sparklinePath([0, 1, 2], 4, 4, 0) → { line: 'M0,4 L2,2 L4,0', ... }
 */
export function sparklinePath(
  values: readonly number[],
  width: number,
  height: number,
  padding = 2,
): SparklinePath {
  const n = values.length;
  if (n === 0 || width <= 0 || height <= 0) {
    return { line: "", area: "", lastX: 0, lastY: height };
  }
  if (n === 1) {
    // Single point: flat line on the baseline (same as an all-equal
    // multi-point series under the formula below).
    const y = height;
    return {
      line: `M0,${y} L${width},${y}`,
      area: `M0,${height} L0,${y} L${width},${y} L${width},${height} Z`,
      lastX: width,
      lastY: y,
    };
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  // Reserve `padding` px at the TOP: the minimum sits on the baseline
  // (y = height) and the peak lands at y = padding instead of clipping
  // against the SVG edge.
  const usableHeight = Math.max(0, height - padding);
  const points: Array<[number, number]> = values.map((v, i) => {
    const x = (i / (n - 1)) * width;
    const y = height - ((v - min) / range) * usableHeight;
    return [x, y];
  });
  const line = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${round2(x)},${round2(y)}`)
    .join(" ");
  const last = points[points.length - 1];
  const area =
    `M0,${height} ` +
    points
      .map(([x, y], i) => `${i === 0 ? "L" : "L"}${round2(x)},${round2(y)}`)
      .join(" ") +
    ` L${round2(last[0])},${height} Z`;
  return { line, area, lastX: last[0], lastY: last[1] };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute a bounded rate from nonnegative safe-integer counts. Returns null
 * when either value is invalid, the denominator is zero, or the numerator
 * exceeds the denominator. The last guard keeps partial/out-of-order provider
 * events from surfacing a plausible-looking rate above 100%.
 */
export function rateFromCounts(
  num: number | null | undefined,
  denom: number | null | undefined,
): number | null {
  if (
    typeof num !== "number" ||
    typeof denom !== "number" ||
    !Number.isSafeInteger(num) ||
    !Number.isSafeInteger(denom) ||
    num < 0 ||
    denom <= 0 ||
    num > denom
  ) {
    return null;
  }
  const rate = num / denom;
  return Number.isFinite(rate) ? rate : null;
}

/**
 * Recipient-level open/click rate. Prefer uniquely delivered
 * campaign-recipient pairs only when that denominator can contain the
 * numerator; otherwise fall back to uniquely sent pairs. Missing or
 * inconsistent provider evidence remains unavailable instead of falling back
 * to gross event totals.
 */
export function rateFromUniqueRecipients(
  numerator: number | null | undefined,
  uniqueDelivered: number | null | undefined,
  uniqueSent: number | null | undefined,
): number | null {
  return (
    rateFromCounts(numerator, uniqueDelivered) ??
    rateFromCounts(numerator, uniqueSent)
  );
}

/**
 * Honor the server's anomaly flag. Centralized here so future
 * client-side overrides (e.g. dismissed anomalies stored in
 * localStorage) have a single chokepoint.
 */
export function isAnomalous(flag: boolean | undefined): boolean {
  return flag === true;
}

/**
 * Map a Range to its human label for tooltips / chip text.
 */
export function rangeLabel(range: "7d" | "30d" | "90d"): string {
  switch (range) {
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "90d":
      return "Last 90 days";
  }
}

/**
 * Refined Dashboard PR 2 — forecast next round-number milestone.
 *
 * Fits a linear regression to the daily subscriber-additions series
 * (least-squares on (day index, adds-that-day)), uses the slope as
 * "subs per day going forward", then projects when the running total
 * crosses the next round milestone (1k, 5k, 10k, 25k, 50k, 100k…).
 *
 * Returns null when:
 *   • series too short (< 7 days of signal)
 *   • slope is <= 0 (we never predict shrinkage)
 *   • milestone is past the 180-day horizon (anything further is noise)
 *
 * Pure function — fully unit-testable; no Date.now() side effects so
 * tests can pass a deterministic `today`.
 */
export function forecastNextMilestone(
  dailyAdds: readonly number[],
  currentTotal: number,
  today: Date = new Date(),
  horizonDays = 180,
): { target: number; crossesAt: Date; daysAway: number } | null {
  const n = dailyAdds.length;
  if (n < 7) return null;
  // Least-squares slope through (i, dailyAdds[i]) for i in 0..n-1
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumXX = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    const y = dailyAdds[i];
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  // Forward growth per day. We use the mean of the projected daily
  // adds across the next 30 days (slope + intercept averaged) so a
  // recent uptick doesn't blow the forecast.
  const projectedDailyAdds = Math.max(0, slope * (n + 15) + intercept);
  if (projectedDailyAdds < 0.5) return null;

  const target = nextRoundMilestone(currentTotal);
  if (target === null) return null;
  const gap = target - currentTotal;
  if (gap <= 0) return null;
  const days = Math.ceil(gap / projectedDailyAdds);
  if (days > horizonDays) return null;
  const crossesAt = new Date(today);
  crossesAt.setDate(crossesAt.getDate() + days);
  return { target, crossesAt, daysAway: days };
}

/**
 * Next round subscriber milestone above `current`. Sequence:
 *   100, 250, 500, 1k, 2.5k, 5k, 10k, 25k, 50k, 100k, 250k, 500k, 1M, …
 */
export function nextRoundMilestone(current: number): number | null {
  const ladder = [
    100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000,
    250_000, 500_000, 1_000_000, 5_000_000, 10_000_000,
  ];
  for (const m of ladder) {
    if (m > current) return m;
  }
  return null;
}

/**
 * Refined Dashboard PR 2 — markdown snapshot of the dashboard for
 * the share-as-snapshot affordance. The user copies this and pastes
 * into Slack / Notion / email; the receiver gets a tidy summary.
 *
 *   📊 Moosewave — Last 30 days
 *   Subscribers: 12,481 (+148)
 *   Open rate:   22.4%   (+1.2pt)
 *   Click rate:  3.1%    (—)
 *   Bounce rate: 0.8%    (-0.3pt)
 *
 * Pure function — no clipboard call here, that's the page's job.
 */
export function dashboardSnapshotMarkdown(input: {
  rangeLabel: string;
  rows: Array<{ label: string; value: string; delta?: { text: string } }>;
  methodology?: string;
}): string {
  const lines: string[] = [];
  lines.push(`📊 Moosewave — ${input.rangeLabel}`);
  for (const r of input.rows) {
    const label = `${r.label}:`.padEnd(13);
    const value = r.value.padEnd(8);
    const delta = r.delta?.text ?? "—";
    lines.push(`${label}${value}${delta}`);
  }
  lines.push("");
  if (input.methodology) {
    lines.push(`_${input.methodology}_`);
    lines.push("");
  }
  lines.push(`_Generated ${new Date().toLocaleString()}_`);
  return lines.join("\n");
}
