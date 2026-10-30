/**
 * lib/campaignBenchmark.ts — "is this campaign actually any good?"
 *
 * `GET /api/v1/campaigns/{id}/benchmark` (apps/api/internal/campaign_benchmarks/
 * campaign_benchmarks.go:60, `read:reports`) compares one campaign against THIS
 * WORKSPACE'S OWN last 90 days rather than against a published industry
 * average, which is the only comparison that means anything when every tenant's
 * audience is different.
 *
 * FOUR CONTRACT DETAILS, each of which a naive reading gets wrong:
 *
 *  1. RATES ARE FRACTIONS HERE (`float64(opens) / den`, line 252), while the
 *     campaign REPORT endpoint one card up returns percentages. The two live on
 *     the same screen. Passing a 0.42 through a percent formatter expecting
 *     percentages prints "0.4%".
 *  2. `verdict` IS ALREADY POLARITY-CORRECTED. The server inverts it for
 *     bounce / complaint / unsubscribe (line 410), so `above` means BETTER for
 *     every metric — a UI that painted "above" as "higher" would tell the
 *     reader a bounce spike was good news.
 *  3. `percentile` IS **NOT** INVERTED. It is the raw rank of this value in the
 *     rolling distribution, so a 95th-percentile bounce rate is terrible. It is
 *     therefore phrased as a plain fact ("higher than 95% of your recent
 *     campaigns"), never as a "top 10%" accolade.
 *  4. THE SERVER SAYS WHEN IT CANNOT COMPARE. `baseline_available` is false
 *     below five prior campaigns, and each metric carries its own `available`
 *     plus a `reason`. That is a first-class "we do not know" — exactly the
 *     signal house rule 8 asks for — so this module surfaces it rather than
 *     rendering a comparison against a baseline of zero.
 *
 * Pure and import-free (house rule 6).
 */

export type BenchmarkVerdict = "above" | "on_par" | "below";

export interface BenchmarkMetric {
  key: string;
  label: string;
  /** This campaign's rate, as a FRACTION in 0..1. Null when unreported. */
  value: number | null;
  /** The workspace's rolling average, as a FRACTION. Null when unreported. */
  baseline: number | null;
  /** Already polarity-corrected: `above` always means BETTER. */
  verdict: BenchmarkVerdict | null;
  /** Raw rank in the distribution, 0..100. NOT polarity-corrected. */
  percentile: number | null;
  /** False when the server refused to compare this metric. */
  available: boolean;
}

export interface CampaignBenchmark {
  baselineDays: number | null;
  sampleSize: number | null;
  minimumSampleSize: number | null;
  /** False when the workspace has too few prior campaigns to compare against. */
  available: boolean;
  metrics: BenchmarkMetric[];
}

/**
 * The five metrics the handler builds, in the order it builds them, with the
 * labels this client shows. A metric the server adds later still renders —
 * `metricLabel` falls back to a de-snaked name — but the known five keep
 * human wording rather than "Unsubscribe rate" spelled by an algorithm.
 */
const METRIC_LABELS: Readonly<Record<string, string>> = {
  open_rate: "Open rate",
  click_rate: "Click rate",
  bounce_rate: "Bounce rate",
  complaint_rate: "Complaint rate",
  unsubscribe_rate: "Unsubscribe rate",
};

export function metricLabel(key: string): string {
  return (
    METRIC_LABELS[key] ??
    key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function fraction(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function verdictOf(value: unknown): BenchmarkVerdict | null {
  return value === "above" || value === "on_par" || value === "below"
    ? value
    : null;
}

export function parseCampaignBenchmark(raw: unknown): CampaignBenchmark {
  const envelope = record(raw);
  const metrics: BenchmarkMetric[] = [];
  const rows =
    envelope && Array.isArray(envelope.metrics) ? envelope.metrics : [];
  for (const entry of rows) {
    const row = record(entry);
    if (!row) continue;
    const key = typeof row.name === "string" ? row.name.trim() : "";
    if (!key) continue;
    const percentile =
      typeof row.percentile === "number" && Number.isFinite(row.percentile)
        ? Math.max(0, Math.min(100, Math.round(row.percentile)))
        : null;
    metrics.push({
      key,
      label: metricLabel(key),
      value: fraction(row.value),
      baseline: fraction(row.baseline),
      verdict: verdictOf(row.verdict),
      percentile,
      available: row.available === true,
    });
  }
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.trunc(value)
      : null;
  return {
    baselineDays: envelope ? count(envelope.baseline_days) : null,
    sampleSize: envelope ? count(envelope.baseline_sample_size) : null,
    minimumSampleSize: envelope ? count(envelope.minimum_sample_size) : null,
    available: Boolean(envelope && envelope.baseline_available === true),
    metrics,
  };
}

/**
 * Why no comparison can be drawn, or null when it can.
 *
 * The sentence names the SAMPLE SIZE the server used and the floor it needs,
 * because "not enough data" without a number leaves the reader unable to tell
 * whether they are one campaign away or twenty.
 */
export function benchmarkUnavailableSentence(
  benchmark: CampaignBenchmark,
): string | null {
  if (benchmark.metrics.length === 0) {
    return "This workspace has not reported a benchmark for this campaign.";
  }
  if (benchmark.available) return null;
  const have = benchmark.sampleSize;
  const need = benchmark.minimumSampleSize;
  if (have === null || need === null) {
    return "There are not yet enough finished campaigns in this workspace to compare against.";
  }
  const days = benchmark.baselineDays ?? 90;
  return `Comparing needs ${need} finished campaigns in the last ${days} days; this workspace has ${have}. Until then this campaign's rates stand on their own.`;
}

/**
 * How a metric compares, in words. Deliberately says BETTER/WORSE rather than
 * higher/lower: the server has already inverted the verdict for bounce,
 * complaint and unsubscribe, so "higher" would be wrong for three of the five.
 */
export function verdictSentence(metric: BenchmarkMetric): string {
  if (!metric.available || metric.verdict === null) {
    return "Not enough history to compare";
  }
  switch (metric.verdict) {
    case "above":
      return "Better than your recent average";
    case "below":
      return "Worse than your recent average";
    default:
      return "In line with your recent average";
  }
}

/**
 * The percentile as a plain fact rather than an accolade.
 *
 * `percentile` is the raw rank and is NOT polarity-corrected, so framing it as
 * "top 5%" would congratulate a workspace on a 95th-percentile bounce rate.
 */
export function percentileSentence(metric: BenchmarkMetric): string | null {
  if (!metric.available || metric.percentile === null) return null;
  return `Higher than ${metric.percentile}% of your recent campaigns`;
}

/** One spoken line per metric: the exact figures and the comparison. */
export function benchmarkRowSpoken(metric: BenchmarkMetric): string {
  if (metric.value === null) return `${metric.label}, not reported.`;
  const value = `${(metric.value * 100).toFixed(2)} percent`;
  const baseline =
    metric.baseline === null
      ? "an unreported average"
      : `${(metric.baseline * 100).toFixed(2)} percent`;
  const rank = percentileSentence(metric);
  return `${metric.label}, ${value} against ${baseline}. ${verdictSentence(metric)}.${
    rank ? ` ${rank}.` : ""
  }`;
}
