/**
 * lib/anomalies.ts — parsing and phrasing for the persisted anomaly log.
 *
 * `GET /api/v1/dashboard/anomalies` returns rows the server wrote when a metric
 * spiked past its z-score threshold (apps/api/internal/analytics/anomalies.go).
 * Uniqueness is (tenant, metric, day), so re-detection on the same day updates
 * the row instead of spamming history.
 *
 * Two things this module is careful about:
 *
 *  - THE NUMBERS TRAVEL WITH THE CLAIM. "Bounces spiked" is an assertion; "412
 *    bounces vs a 38 average, 6.2σ" is evidence. A phone has less room, not
 *    less need for it — someone who has just been paged is reading this
 *    instead of a laptop.
 *  - A ROW WITHOUT EVIDENCE IS DROPPED. A row missing its metric or its
 *    observed value cannot be phrased honestly, and an anomaly card that says
 *    "— spiked" is worse than one row shorter.
 */

export interface AnomalyEvent {
  id: string;
  metric: string;
  /** Human label for the metric, e.g. "Bounces". */
  label: string;
  value: number;
  mean: number | null;
  zScore: number | null;
  /** ISO instant the detection was recorded. */
  detectedAt: string | null;
  /** The day the spike belongs to, ISO. */
  dayBucket: string | null;
}

/** Metrics the server currently detects on, with reader-facing names. */
const METRIC_LABELS: Record<string, string> = {
  bounces: "Bounces",
  bounces_total: "Bounces",
  complaints: "Complaints",
  unsubscribes: "Unsubscribes",
  opens: "Opens",
  clicks: "Clicks",
  sends: "Sends",
};

/** Title-case an unknown metric key rather than printing `unique_bounces`. */
export function metricLabel(metric: string): string {
  const known = METRIC_LABELS[metric];
  if (known) return known;
  const words = metric.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Metric";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function parseAnomalies(raw: unknown): AnomalyEvent[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(record(raw)?.items)
      ? (record(raw)?.items as unknown[])
      : [];

  const out: AnomalyEvent[] = [];
  for (const row of list) {
    const item = record(row);
    if (!item) continue;
    const metric = isoString(item.metric);
    const value = finite(item.value);
    if (metric === null || value === null) continue;
    out.push({
      id: isoString(item.id) ?? `${metric}:${isoString(item.dayBucket) ?? out.length}`,
      metric,
      label: metricLabel(metric),
      value,
      mean: finite(item.mean),
      zScore: finite(item.zScore),
      detectedAt: isoString(item.detectedAt),
      dayBucket: isoString(item.dayBucket),
    });
  }
  return out;
}

/**
 * How far above normal the spike was, as a multiple of the mean. Null when the
 * baseline is zero or absent — "∞× the average" is not a fact anyone can act
 * on, and dividing by zero silently prints `Infinity`.
 */
export function severityMultiple(event: AnomalyEvent): number | null {
  if (event.mean === null || event.mean <= 0) return null;
  return event.value / event.mean;
}

/** Severity band, used for the pill tone. Thresholds mirror z-score bands. */
export function anomalyTone(event: AnomalyEvent): "warning" | "danger" {
  return event.zScore !== null && event.zScore >= 4 ? "danger" : "warning";
}
