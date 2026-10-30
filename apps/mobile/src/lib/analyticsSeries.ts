/**
 * lib/analyticsSeries.ts — the pure edge between the analytics API and the
 * chart primitives.
 *
 * Every one of these endpoints is a real, verified route in
 * apps/api/internal/analytics (handlers.go MountRoutes). What they are NOT is
 * stable in the face of a partial deployment: the dominant defect class in this
 * app's own logic audit is "response-shape drift silently produces an empty
 * screen". So each parser here is deliberately total — it accepts `unknown`,
 * keeps every row it can understand, drops the ones it cannot, and never throws
 * on a missing field. The screen's job is then only to distinguish "the request
 * failed" from "the workspace has no data yet", which it can do from the query
 * state rather than from the shape of the body.
 *
 * Rates from this API are FRACTIONS in [0,1] (`safeRate` in
 * template_leaderboard.go clamps to that range), so they are passed to
 * `percent()` unchanged — never multiplied here.
 */
import { date } from "@/lib/format";

function asArray(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const inner = (raw as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

function asRecord(row: unknown): Record<string, unknown> | null {
  return row && typeof row === "object" && !Array.isArray(row)
    ? (row as Record<string, unknown>)
    : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function rate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(1, value)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/* ------------------------- subscriber timeseries ------------------------- */

/** One end-of-day cumulative subscriber total. */
export interface SubscriberPoint {
  date: string;
  count: number;
}

/** GET /api/v1/analytics/subscribers/timeseries → `{ range, points[] }`. */
export function parseSubscriberTimeseries(raw: unknown): SubscriberPoint[] {
  const out: SubscriberPoint[] = [];
  for (const row of asArray(raw, "points")) {
    const record = asRecord(row);
    if (!record) continue;
    const day = text(record.date);
    const total = count(record.count);
    // A day with no readable total is a GAP, not a zero: charting it as zero
    // would draw a cliff the workspace never experienced.
    if (day === null || total === null) continue;
    out.push({ date: day, count: total });
  }
  return out;
}

export interface ChartInput {
  labels: string[];
  values: number[];
}

/** Chart-ready arrays. Dates carry the year (an undated "Jan 3" is ambiguous). */
export function subscriberChartInput(points: readonly SubscriberPoint[]): ChartInput {
  return {
    labels: points.map((point) => date(point.date, point.date)),
    values: points.map((point) => point.count),
  };
}

/**
 * Net movement across the plotted window. Null for fewer than two points —
 * a single measurement has no change to report, and rendering "+0" would
 * claim a flat window that was never observed.
 */
export function subscriberNetChange(
  points: readonly SubscriberPoint[],
): number | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  return last.count - first.count;
}

/* --------------------------- template leaderboard ------------------------ */

export interface LeaderboardRow {
  id: string;
  name: string;
  campaignsUsed: number;
  sent: number;
  opens: number;
  clicks: number;
  openRate: number | null;
  clickRate: number | null;
}

/** GET /api/v1/analytics/template-leaderboard → `{ items[] }`. */
export function parseTemplateLeaderboard(raw: unknown): LeaderboardRow[] {
  const out: LeaderboardRow[] = [];
  for (const row of asArray(raw, "items")) {
    const record = asRecord(row);
    if (!record) continue;
    const id = text(record.template_id);
    if (id === null) continue;
    out.push({
      id,
      name: text(record.template_name) ?? "Untitled template",
      campaignsUsed: count(record.campaigns_used) ?? 0,
      sent: count(record.sent) ?? 0,
      opens: count(record.opens) ?? 0,
      clicks: count(record.clicks) ?? 0,
      openRate: rate(record.open_rate),
      clickRate: rate(record.click_rate),
    });
  }
  return out;
}

/* --------------------------------- fatigue ------------------------------- */

export interface FatigueDecile {
  /** Observed sends range for the bucket, e.g. "3-5". */
  bucket: string;
  subscribers: number;
  openRate: number;
  unsubRate: number;
}

/** GET /api/v1/analytics/fatigue → `{ deciles[] }`. */
export function parseFatigueDeciles(raw: unknown): FatigueDecile[] {
  const out: FatigueDecile[] = [];
  for (const row of asArray(raw, "deciles")) {
    const record = asRecord(row);
    if (!record) continue;
    const bucket = text(record.sends_bucket);
    const openRate = rate(record.open_rate);
    const unsubRate = rate(record.unsub_rate);
    if (bucket === null || openRate === null || unsubRate === null) continue;
    out.push({
      bucket,
      subscribers: count(record.subscribers) ?? 0,
      openRate,
      unsubRate,
    });
  }
  return out;
}

export type FatigueSeverity = "ok" | "watch" | "fatigued";

export interface FatigueVerdict {
  severity: FatigueSeverity;
  /** One plain-English sentence. The chart is the evidence; this is the read. */
  headline: string;
  /** Relative fall in open rate from the light-volume baseline, 0..1. */
  decline: number;
  /** Bucket label of the heaviest-mailed decile. */
  heaviestBucket: string;
}

/** Buckets needed before a curve means anything. Fewer is a small workspace. */
const MIN_DECILES_FOR_VERDICT = 4;
const WATCH_THRESHOLD = 0.15;
const FATIGUED_THRESHOLD = 0.35;

/**
 * Turn the decile curve into the one sentence an operator actually wants
 * before deciding whether to fire another send today.
 *
 * The comparison is the heaviest-mailed decile against the mean of the three
 * lightest — not against the overall mean, which the heavy deciles themselves
 * drag down and which therefore understates the effect. Returns null rather
 * than a shrug when there is not enough of a curve to read; a verdict computed
 * from two buckets would be confident noise.
 */
export function fatigueVerdict(
  deciles: readonly FatigueDecile[],
): FatigueVerdict | null {
  if (deciles.length < MIN_DECILES_FOR_VERDICT) return null;
  const lightest = deciles.slice(0, 3);
  const heaviest = deciles[deciles.length - 1];
  if (!heaviest) return null;

  const baseline =
    lightest.reduce((sum, d) => sum + d.openRate, 0) / lightest.length;
  if (!(baseline > 0)) return null;

  const decline = Math.max(0, (baseline - heaviest.openRate) / baseline);
  const severity: FatigueSeverity =
    decline >= FATIGUED_THRESHOLD
      ? "fatigued"
      : decline >= WATCH_THRESHOLD
        ? "watch"
        : "ok";

  const pct = Math.round(decline * 100);
  const headline =
    severity === "fatigued"
      ? `Your most-mailed subscribers open ${pct}% less than your least-mailed. Consider slowing down.`
      : severity === "watch"
        ? `Opens fall ${pct}% at your heaviest send volume. Worth watching.`
        : "Open rates hold up across send volumes. No fatigue signal.";

  return { severity, headline, decline, heaviestBucket: heaviest.bucket };
}
