/**
 * lib/chartScale.ts — the arithmetic behind every chart, with no React and no
 * `react-native` import, so it is directly unit-testable.
 *
 * The parts that are easy to get subtly wrong, and are therefore here rather
 * than inlined in a component:
 *
 *  - a domain of identical values (every point is 40) must not collapse to a
 *    zero-height range and divide by zero;
 *  - a single data point must still render somewhere sensible;
 *  - "nice" axis ticks must land on human numbers (0, 25, 50) rather than the
 *    raw extremes (3.7, 41.2);
 *  - a series containing nulls (a day with no send) must break the line rather
 *    than interpolate a fictional value across the gap.
 */

export interface Extent {
  min: number;
  max: number;
}

/**
 * The value range a chart should plot.
 *
 * Counts and rates are non-negative, and starting a count axis anywhere but
 * zero exaggerates differences — the single most common way a chart misleads.
 * So `zeroBased` defaults to true and only a series with genuine negatives
 * (a week-over-week delta) turns it off.
 *
 * An all-equal series gets a symmetric pad so the line lands mid-plot instead
 * of hugging an edge or dividing by zero.
 */
export function extentOf(
  values: readonly (number | null | undefined)[],
  { zeroBased = true }: { zeroBased?: boolean } = {},
): Extent {
  const finite = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (finite.length === 0) return { min: 0, max: 1 };

  let min = Math.min(...finite);
  let max = Math.max(...finite);

  if (zeroBased && min > 0) min = 0;
  if (zeroBased && max < 0) max = 0;

  if (min === max) {
    // A flat series at EXACTLY ZERO on a zero-based axis pads UPWARD only.
    //
    // Padding symmetrically gave `{ min: -1, max: 1 }`, so a series of all
    // zeroes drew a y-axis running 1 down to -1 and filled the area from the
    // line down to a -1 floor. On the suppressions screen that rendered a
    // pink band BELOW ZERO under "Added · last 30 days" — a shape that reads
    // as negative suppressions, which cannot happen. Seen in-app on
    // 2026-08-19.
    //
    // Only this case is affected: a flat series at any positive value already
    // has min forced to 0 above (so min !== max here), and a flat negative one
    // has max forced to 0.
    if (zeroBased && min === 0) return { min: 0, max: 1 };
    // Otherwise pad by 1 (or 10% for large values) so it renders as a centered
    // horizontal line rather than a division by zero.
    const pad = Math.max(1, Math.abs(min) * 0.1);
    return { min: min - pad, max: max + pad };
  }
  return { min, max };
}

/**
 * Map a value into pixel space. `y` is inverted because SVG's origin is at the
 * top — forgetting this is why hand-rolled charts render upside down.
 */
export function scaleY(
  value: number,
  extent: Extent,
  height: number,
): number {
  const span = extent.max - extent.min;
  if (span === 0) return height / 2;
  const ratio = (value - extent.min) / span;
  return height - ratio * height;
}

/** Map an index onto the x axis. A single point sits centered, not at x=0. */
export function scaleX(index: number, count: number, width: number): number {
  if (count <= 1) return width / 2;
  return (index / (count - 1)) * width;
}

/**
 * Human-friendly axis ticks: roughly `count` INTERVALS (so `count + 1` labels
 * when the extent divides evenly), stepping on the 1 / 2 / 2.5 / 5 / 10 ladder
 * so labels read as 0 / 25 / 50 / 75 / 100 rather than 0 / 23.7 / 47.4.
 *
 * The 2.5 rung matters: without it a 0–100 axis at four intervals rounds its
 * step up to 50 and you get three labels on a chart with room for five.
 */
export function niceTicks(extent: Extent, count = 4): number[] {
  const span = extent.max - extent.min;
  if (!Number.isFinite(span) || span <= 0) return [extent.min];

  const rough = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const rung =
    normalized <= 1
      ? 1
      : normalized <= 2
        ? 2
        : normalized <= 2.5
          ? 2.5
          : normalized <= 5
            ? 5
            : 10;
  const step = rung * magnitude;

  const first = Math.ceil(extent.min / step) * step;
  const ticks: number[] = [];
  for (let v = first; v <= extent.max + step * 1e-9; v += step) {
    // Re-round to kill float drift (0.30000000000000004).
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks;
}

/**
 * Label a y-axis tick without collapsing two distinct gridlines into the same
 * text.
 *
 * The chart formatted every tick with `compactNum`, which rounds to whole
 * numbers — fine for the counts these axes usually carry, and wrong the moment
 * the step is fractional. A 0–1 domain gets ticks [0, 0.5, 1] and printed
 * "0", "0", "1": two different gridlines wearing the same label. Seen on the
 * suppressions chart on 2026-08-19.
 *
 * The step decides the precision, so an axis only ever shows the digits it
 * actually needs.
 */
export function tickLabel(
  tick: number,
  ticks: readonly number[],
  compact: (value: number) => string,
): string {
  const step = ticks.length > 1 ? Math.abs(ticks[1]! - ticks[0]!) : 0;
  if (step === 0 || step >= 1) return compact(tick);
  // Take the precision FROM THE STEP ITSELF: 0.5 needs one decimal, 0.25 needs
  // two. (`-log10(step)` is wrong here -- it rounds 0.25 to one decimal and
  // prints "0.3".) Capped so float drift in a step cannot produce an
  // unreadable label.
  const decimals = Math.min(3, (String(step).split(".")[1] ?? "").length || 1);
  return tick.toFixed(decimals);
}

export interface PathSegment {
  /** Index into the original series where this unbroken run starts. */
  startIndex: number;
  points: { x: number; y: number }[];
}

/**
 * Split a series into unbroken runs, so nulls become GAPS instead of straight
 * lines drawn through missing data. A chart that interpolates across an outage
 * shows a smooth trend where the truth is "we have no idea".
 */
export function pathSegments(
  values: readonly (number | null | undefined)[],
  extent: Extent,
  width: number,
  height: number,
): PathSegment[] {
  const segments: PathSegment[] = [];
  let current: PathSegment | null = null;

  values.forEach((value, index) => {
    const usable = typeof value === "number" && Number.isFinite(value);
    if (!usable) {
      current = null;
      return;
    }
    const point = {
      x: scaleX(index, values.length, width),
      y: scaleY(value as number, extent, height),
    };
    if (!current) {
      current = { startIndex: index, points: [point] };
      segments.push(current);
    } else {
      current.points.push(point);
    }
  });

  return segments;
}

/** An SVG `d` string for a run of points. Straight segments — a smoothed
 *  spline would invent values between real measurements. */
export function linePath(points: readonly { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    // A lone point has no line; callers render a marker for it instead.
    const p = points[0] as { x: number; y: number };
    return `M ${p.x} ${p.y}`;
  }
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
    .join(" ");
}

/** Closes a line path down to the baseline for an area fill. */
export function areaPath(
  points: readonly { x: number; y: number }[],
  baselineY: number,
): string {
  if (points.length < 2) return "";
  const first = points[0] as { x: number; y: number };
  const last = points[points.length - 1] as { x: number; y: number };
  return `${linePath(points)} L ${last.x} ${baselineY} L ${first.x} ${baselineY} Z`;
}

/**
 * Which data index a touch at `x` refers to. Used for scrubbing — the phone's
 * equivalent of a desktop hover crosshair.
 */
export function indexAtX(x: number, count: number, width: number): number {
  if (count <= 1) return 0;
  const ratio = width === 0 ? 0 : x / width;
  const index = Math.round(ratio * (count - 1));
  return Math.min(count - 1, Math.max(0, index));
}
