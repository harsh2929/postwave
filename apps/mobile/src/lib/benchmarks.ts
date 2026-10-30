/**
 * lib/benchmarks.ts — "is 34% good?", which is the question a rate on its own
 * cannot answer.
 *
 * Backed by `GET /api/v1/dashboard/benchmarks`
 * (apps/api/internal/analytics/dashboard_layout.go::GetBenchmarks), which
 * returns `{ rows: [{ metric, average, source }], note }` where `average` is a
 * FRACTION in [0,1] and `metric` is one of opens | clicks | bounces | unsubs.
 *
 * Two things this module refuses to do, because both are how a benchmark
 * misleads:
 *
 *  - IT NEVER GUESSES THE DIRECTION. A higher open rate is good; a higher
 *    bounce rate is not. The same "+40% vs average" is a win on one row and an
 *    incident on the next, so direction is a property of the metric and is
 *    declared here rather than inferred from the sign.
 *  - IT NEVER CALLS NOISE A DIFFERENCE. A workspace 2% off the average is
 *    level, not "behind". The band is RELATIVE (`LEVEL_BAND`) because the
 *    metrics differ by an order of magnitude — half a point is nothing on a
 *    21% open rate and enormous on a 0.9% bounce rate.
 *
 * The server's `source` and `note` travel with every verdict. The averages ship
 * as illustrative public figures until the platform aggregate has run
 * (`illustrativeBenchmarks`), and a comparison whose provenance is hidden is a
 * comparison the reader cannot weigh.
 *
 * Import-free by design so it is testable in the node vitest environment.
 */

export type BenchmarkMetric = "opens" | "clicks" | "bounces" | "unsubs";

export interface BenchmarkRow {
  metric: BenchmarkMetric;
  /** Fraction in [0,1]. */
  average: number;
  /** Human-readable provenance, e.g. "Industry average 2024". */
  source: string;
}

export interface Benchmarks {
  rows: BenchmarkRow[];
  /** The server's own caveat about where these averages came from. */
  note: string | null;
}

const METRICS: readonly BenchmarkMetric[] = [
  "opens",
  "clicks",
  "bounces",
  "unsubs",
];

/** Metrics where LOWER is the good direction. */
const LOWER_IS_BETTER: ReadonlySet<BenchmarkMetric> = new Set<BenchmarkMetric>([
  "bounces",
  "unsubs",
]);

const LABELS: Readonly<Record<BenchmarkMetric, string>> = {
  opens: "Open rate",
  clicks: "Click rate",
  bounces: "Bounce rate",
  unsubs: "Unsubscribe rate",
};

/**
 * Relative distance from the average inside which the two are reported as
 * level. 10% of the average — so a 21.4% benchmark reads as level anywhere
 * between 19.3% and 23.5%, which is the width of ordinary week-to-week drift.
 */
export const LEVEL_BAND = 0.1;

function isMetric(value: unknown): value is BenchmarkMetric {
  return (
    typeof value === "string" &&
    (METRICS as readonly string[]).includes(value)
  );
}

/** Total parser: keeps what it understands, drops what it does not. */
export function parseBenchmarks(raw: unknown): Benchmarks {
  const body =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const rows: BenchmarkRow[] = [];
  const rawRows = body && Array.isArray(body.rows) ? body.rows : [];
  for (const entry of rawRows) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (!isMetric(row.metric)) continue;
    const average = row.average;
    // Out-of-domain averages are dropped, not clamped: a 4.0 "fraction" means
    // the deployment changed units, and clamping it to 1.0 would silently
    // compare a rate against a wrong number rather than showing nothing.
    if (
      typeof average !== "number" ||
      !Number.isFinite(average) ||
      average < 0 ||
      average > 1
    ) {
      continue;
    }
    const source =
      typeof row.source === "string" && row.source.trim() !== ""
        ? row.source.trim()
        : "Platform benchmark";
    rows.push({ metric: row.metric, average, source });
  }
  const note =
    body && typeof body.note === "string" && body.note.trim() !== ""
      ? body.note.trim()
      : null;
  return { rows, note };
}

export function benchmarkLabel(metric: BenchmarkMetric): string {
  return LABELS[metric];
}

/** "higher" means a bigger number is the better outcome. */
export function benchmarkDirection(
  metric: BenchmarkMetric,
): "higher" | "lower" {
  return LOWER_IS_BETTER.has(metric) ? "lower" : "higher";
}

export type BenchmarkVerdict = "ahead" | "behind" | "level";

export interface BenchmarkComparison {
  metric: BenchmarkMetric;
  label: string;
  /** The workspace's own rate, fraction in [0,1]. */
  own: number;
  average: number;
  source: string;
  /** Signed relative distance: (own − average) / average. */
  relative: number;
  verdict: BenchmarkVerdict;
  /** One sentence, already directional. Never leads with a bare number. */
  sentence: string;
}

function verdictFor(
  metric: BenchmarkMetric,
  relative: number,
): BenchmarkVerdict {
  if (Math.abs(relative) < LEVEL_BAND) return "level";
  const above = relative > 0;
  return benchmarkDirection(metric) === "higher"
    ? above
      ? "ahead"
      : "behind"
    : above
      ? "behind"
      : "ahead";
}

/**
 * Compare one workspace rate against its benchmark.
 *
 * Returns null when there is nothing honest to say: no measured rate, no
 * benchmark row, or a zero average (which would make the relative distance
 * infinite rather than large).
 */
export function compareToBenchmark(
  metric: BenchmarkMetric,
  own: number | null,
  benchmarks: Benchmarks,
): BenchmarkComparison | null {
  if (own === null || !Number.isFinite(own)) return null;
  const row = benchmarks.rows.find((candidate) => candidate.metric === metric);
  if (!row || row.average <= 0) return null;

  const relative = (own - row.average) / row.average;
  const verdict = verdictFor(metric, relative);
  const magnitude = Math.round(Math.abs(relative) * 100);
  const label = LABELS[metric];
  const sentence =
    verdict === "level"
      ? `${label} is in line with the benchmark.`
      : `${label} is ${magnitude}% ${relative > 0 ? "above" : "below"} the benchmark — ${
          verdict === "ahead" ? "better" : "worse"
        } than typical.`;

  return {
    metric,
    label,
    own,
    average: row.average,
    source: row.source,
    relative,
    verdict,
    sentence,
  };
}

/**
 * Every comparison that can be made, in the fixed reading order
 * opens → clicks → bounces, which is the order the deliverability tiles above
 * them already use. `unsubs` is omitted: the phone does not measure an
 * unsubscribe rate anywhere, and a benchmark with no own-value beside it is a
 * fact about the industry, not about this workspace.
 */
export function compareAll(
  rates: {
    opens: number | null;
    clicks: number | null;
    bounces: number | null;
  },
  benchmarks: Benchmarks,
): BenchmarkComparison[] {
  const out: BenchmarkComparison[] = [];
  for (const metric of ["opens", "clicks", "bounces"] as const) {
    const comparison = compareToBenchmark(metric, rates[metric], benchmarks);
    if (comparison) out.push(comparison);
  }
  return out;
}
