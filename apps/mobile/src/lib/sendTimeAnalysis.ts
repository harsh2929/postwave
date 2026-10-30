/**
 * lib/sendTimeAnalysis.ts — the send-time heatmap, as data rules.
 *
 * BACKS `GET /api/v1/send-time-opt/best-time-analysis?days=N`
 * (apps/api/internal/send_time_opt/analysis.go:37). The response is 168
 * buckets — one per (day-of-week × hour-of-day) — plus a pre-ranked
 * `top_buckets` slice of 12. Each bucket carries the raw counts from
 * `campaign_report_events` and a `subscriber_signal` count merged in from
 * `subscribers.best_send_hour`.
 *
 * WHY THIS ENDPOINT AND NOT `/send-time-opt/heatmap`. Both exist and both are
 * mounted. `/heatmap` (dow_pattern.go:416) requires a `segment_id` or a
 * `campaign_id` and 404s `insufficient_data` below thirty subscribers with open
 * history — so a phone surface built on it opens onto a segment picker and then,
 * for most workspaces, onto a dead end. `best-time-analysis` is tenant-wide,
 * takes no required parameter, and always answers 200. It is also the STRICTLY
 * RICHER answer: `/heatmap` returns a normalised fraction per cell and nothing
 * else, while this one returns sent/delivered/opened/clicked per cell, so the
 * screen can say WHY a cell is bright instead of only that it is.
 *
 * THE THREE THINGS THAT ARE EASY TO GET WRONG HERE, ALL OF THEM ABOUT ZERO:
 *
 *  1. `open_rate` IS 0 WHEN NOTHING WAS SENT. `finalizeBucket` (analysis.go:159)
 *     divides by `delivered`, falling back to `sent`, and leaves the rate at its
 *     zero value when both are zero. So a 0.0 open rate means EITHER "we sent
 *     into this hour and nobody opened" OR "we have never sent into this hour".
 *     Those are opposite facts. `bucketMetric` returns `null` for the second,
 *     and the screen renders an em-dash for it — never 0%.
 *
 *  2. `score` IS NON-ZERO WITH NO SENDS AT ALL. It is
 *     `open_rate + 2*click_rate + subscriber_signal/1000`, so a bucket you have
 *     never sent into still scores if subscribers' modelled best hour lands
 *     there. That is the single most useful cell on the grid — "your audience is
 *     awake here and you have never used it" — so `subscriber_signal` is a
 *     first-class metric rather than a tiebreak.
 *
 *  3. `top_buckets` IS ALWAYS TWELVE ROWS LONG, EVEN FOR AN EMPTY WORKSPACE.
 *     `sort.Slice` over 168 all-zero buckets is not stable and is not filtered
 *     (analysis.go:109-118), so a workspace with no history gets twelve
 *     arbitrary "Sunday 00:00" rows presented as its best send times. `topWindows`
 *     drops anything with no measurement, which is what makes that case render
 *     as "nothing measured yet" instead of as advice.
 *
 * A NOTE ON THE HOUR'S TIMEZONE. The column is named `hour_utc` and is produced
 * by `EXTRACT(HOUR FROM at)` over a `timestamptz`, which resolves in the
 * server's session timezone. Everything downstream — the per-subscriber
 * best-send-hour in `lib/subscriberSendTime.ts`, the scheduler's
 * `HourOfWeek` — is UTC, so this module treats it as UTC throughout. Naming and
 * local-time projection live next door in `lib/sendTimeLabels.ts`, which is
 * where that assumption is actually rendered.
 *
 * Import-free on purpose (house rule 5): every rule below is exercised by
 * sendTimeAnalysis.test.ts in the node vitest environment.
 */

export const HOURS_PER_DAY = 24;
export const DAYS_PER_WEEK = 7;
export const BUCKETS_PER_WEEK = DAYS_PER_WEEK * HOURS_PER_DAY;

/** One (day-of-week, hour) cell, normalised from the wire. */
export interface SendTimeBucket {
  /** 0 (Sunday) .. 6 (Saturday), UTC. */
  dayOfWeek: number;
  /** 0..23, UTC. */
  hourUTC: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  openRate: number;
  clickRate: number;
  score: number;
  /** Subscribers whose modelled best hour falls in this cell. */
  subscriberSignal: number;
}

export interface SendTimeAnalysis {
  lookbackDays: number;
  generatedAt: string | null;
  /** Exactly 168 buckets, dense, ordered Sunday 00:00 → Saturday 23:00. */
  grid: SendTimeBucket[];
}

export type SendTimeMetric = "score" | "openRate" | "clickRate" | "signal";

export const SEND_TIME_METRICS: readonly SendTimeMetric[] = [
  "score",
  "openRate",
  "clickRate",
  "signal",
];

/** The lookback windows the screen offers. The API accepts 1..730. */
export const SEND_TIME_LOOKBACKS = [30, 90, 180] as const;
export type SendTimeLookback = (typeof SEND_TIME_LOOKBACKS)[number];
export const DEFAULT_SEND_TIME_LOOKBACK: SendTimeLookback = 90;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function bucketKey(dayOfWeek: number, hourUTC: number): number {
  return dayOfWeek * HOURS_PER_DAY + hourUTC;
}

function emptyBucket(dayOfWeek: number, hourUTC: number): SendTimeBucket {
  return {
    dayOfWeek,
    hourUTC,
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    openRate: 0,
    clickRate: 0,
    score: 0,
    subscriberSignal: 0,
  };
}

function parseBucket(raw: unknown): SendTimeBucket | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const dayOfWeek = num(row["day_of_week"]);
  const hourUTC = num(row["hour_utc"]);
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek >= DAYS_PER_WEEK) {
    return null;
  }
  if (!Number.isInteger(hourUTC) || hourUTC < 0 || hourUTC >= HOURS_PER_DAY) {
    return null;
  }
  return {
    dayOfWeek,
    hourUTC,
    sent: num(row["sent"]),
    delivered: num(row["delivered"]),
    opened: num(row["opened"]),
    clicked: num(row["clicked"]),
    openRate: num(row["open_rate"]),
    clickRate: num(row["click_rate"]),
    score: num(row["score"]),
    subscriberSignal: num(row["subscriber_signal"]),
  };
}

/**
 * Normalise the wire into a DENSE 168-cell grid.
 *
 * The handler already emits all 168 (analysis.go:97-108), but a gateway, a
 * cache or a future version may not, and a sparse grid rendered as a heatmap
 * silently shifts every cell after the gap. Building the grid by index rather
 * than by iteration makes that impossible.
 *
 * Returns `null` — not an empty analysis — when the payload is not an object
 * with a heatmap array. "The request failed" and "the workspace has no send
 * history" are different states and the screen renders them differently.
 */
export function parseSendTimeAnalysis(raw: unknown): SendTimeAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const heatmap = body["heatmap"];
  if (!Array.isArray(heatmap)) return null;

  const grid: SendTimeBucket[] = [];
  for (let day = 0; day < DAYS_PER_WEEK; day += 1) {
    for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
      grid.push(emptyBucket(day, hour));
    }
  }
  for (const entry of heatmap) {
    const bucket = parseBucket(entry);
    if (!bucket) continue;
    grid[bucketKey(bucket.dayOfWeek, bucket.hourUTC)] = bucket;
  }

  const generatedAt = body["generated_at"];
  const lookback = num(body["lookback_days"]);
  return {
    lookbackDays: lookback > 0 ? lookback : DEFAULT_SEND_TIME_LOOKBACK,
    generatedAt: typeof generatedAt === "string" && generatedAt ? generatedAt : null,
    grid,
  };
}

/** The cell at (day, hour), or null when the grid is not the expected shape. */
export function bucketAt(
  analysis: SendTimeAnalysis,
  dayOfWeek: number,
  hourUTC: number,
): SendTimeBucket | null {
  return analysis.grid[bucketKey(dayOfWeek, hourUTC)] ?? null;
}

/**
 * Did we ever SEND into this cell? The denominator `finalizeBucket` uses,
 * reproduced exactly (analysis.go:163-166) so the phone and the server agree on
 * what the rate is a rate OF.
 */
export function bucketDenominator(bucket: SendTimeBucket): number {
  return bucket.delivered > 0 ? bucket.delivered : bucket.sent;
}

/**
 * The value of one metric for one cell — or `null` when there is NO
 * MEASUREMENT, which is not the same number as zero.
 *
 *  - openRate/clickRate: absent unless something was delivered or sent.
 *  - score: absent unless the cell has either send history or audience signal;
 *    a cell with neither scores 0.0 because nothing was measured, not because
 *    it measured badly.
 *  - signal: a genuine 0 per cell — "no subscriber's modelled hour is here" is a
 *    measurement. Whether the MODEL exists at all is a grid-level question, and
 *    `metricIsMeasurable` answers it.
 */
export function bucketMetric(
  bucket: SendTimeBucket,
  metric: SendTimeMetric,
): number | null {
  switch (metric) {
    case "openRate":
      return bucketDenominator(bucket) > 0 ? bucket.openRate : null;
    case "clickRate":
      return bucketDenominator(bucket) > 0 ? bucket.clickRate : null;
    case "signal":
      return bucket.subscriberSignal;
    case "score":
    default:
      return bucketDenominator(bucket) > 0 || bucket.subscriberSignal > 0
        ? bucket.score
        : null;
  }
}

/**
 * Is this metric measurable AT ALL for this workspace?
 *
 * Per-cell absence is one question; "the send-time model has never run, so
 * every cell's audience count is zero" is another, and rendering the second as
 * a grid of honest zeroes reads as "nobody is ever awake". A metric with no
 * non-null, non-zero cell anywhere is reported unmeasurable so the screen can
 * say why the grid is blank.
 */
export function metricIsMeasurable(
  analysis: SendTimeAnalysis,
  metric: SendTimeMetric,
): boolean {
  for (const bucket of analysis.grid) {
    const value = bucketMetric(bucket, metric);
    if (value !== null && value > 0) return true;
  }
  return false;
}

/** The largest measured value, used to scale the colour ramp. 0 when none. */
export function metricPeak(
  analysis: SendTimeAnalysis,
  metric: SendTimeMetric,
): number {
  let peak = 0;
  for (const bucket of analysis.grid) {
    const value = bucketMetric(bucket, metric);
    if (value !== null && value > peak) peak = value;
  }
  return peak;
}

/**
 * 0..1 position on the colour ramp. `null` in means "no measurement", and the
 * caller must paint that as an EMPTY cell rather than as the coldest colour —
 * "we never sent here" and "we sent here and it died" must not look alike.
 */
export function rampIntensity(value: number | null, peak: number): number | null {
  if (value === null) return null;
  if (peak <= 0) return 0;
  const ratio = value / peak;
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

export interface SendTimeWindow {
  bucket: SendTimeBucket;
  value: number;
  rank: number;
}

/**
 * The ranked windows for a metric, measured cells only.
 *
 * Deliberately re-ranked here rather than reading the server's `top_buckets`:
 * that slice is fixed to `score` and, as the header notes, is twelve rows of
 * noise for a workspace with no history. Re-ranking is also what lets the metric
 * switch mean anything — "best by clicks" is a different list, and there is no
 * endpoint for it.
 *
 * Ties break toward the cell with more audience signal, then earlier in the
 * week, so the order is total and the list does not reshuffle between renders.
 */
export function topWindows(
  analysis: SendTimeAnalysis,
  metric: SendTimeMetric,
  limit = 5,
): SendTimeWindow[] {
  const scored: { bucket: SendTimeBucket; value: number }[] = [];
  for (const bucket of analysis.grid) {
    const value = bucketMetric(bucket, metric);
    if (value === null || value <= 0) continue;
    scored.push({ bucket, value });
  }
  scored.sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    if (b.bucket.subscriberSignal !== a.bucket.subscriberSignal) {
      return b.bucket.subscriberSignal - a.bucket.subscriberSignal;
    }
    return (
      bucketKey(a.bucket.dayOfWeek, a.bucket.hourUTC) -
      bucketKey(b.bucket.dayOfWeek, b.bucket.hourUTC)
    );
  });
  return scored
    .slice(0, Math.max(0, limit))
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/** Totals across the whole window — the denominator behind every rate. */
export interface SendTimeTotals {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  modelledSubscribers: number;
  /** Cells with any send history. 0 means the workspace has never sent. */
  measuredCells: number;
}

export function analysisTotals(analysis: SendTimeAnalysis): SendTimeTotals {
  const totals: SendTimeTotals = {
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    modelledSubscribers: 0,
    measuredCells: 0,
  };
  for (const bucket of analysis.grid) {
    totals.sent += bucket.sent;
    totals.delivered += bucket.delivered;
    totals.opened += bucket.opened;
    totals.clicked += bucket.clicked;
    totals.modelledSubscribers += bucket.subscriberSignal;
    if (bucketDenominator(bucket) > 0) totals.measuredCells += 1;
  }
  return totals;
}

/**
 * True when the workspace has neither send history nor a subscriber model in
 * this window — the honest "nothing to show yet" state, distinct from a failed
 * fetch and from a grid that is merely quiet.
 */
export function analysisIsEmpty(analysis: SendTimeAnalysis): boolean {
  const totals = analysisTotals(analysis);
  return totals.measuredCells === 0 && totals.modelledSubscribers === 0;
}
