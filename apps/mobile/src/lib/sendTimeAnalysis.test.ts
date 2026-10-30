import { describe, expect, it } from "vitest";

import {
  analysisIsEmpty,
  analysisTotals,
  bucketAt,
  bucketMetric,
  BUCKETS_PER_WEEK,
  metricIsMeasurable,
  metricPeak,
  parseSendTimeAnalysis,
  rampIntensity,
  topWindows,
} from "./sendTimeAnalysis";
import { formatRate } from "./sendTimeLabels";

/** One wire bucket, in the handler's own JSON shape (analysis.go:17-28). */
function wireBucket(
  dayOfWeek: number,
  hourUTC: number,
  extra: Record<string, number> = {},
): Record<string, number> {
  return {
    day_of_week: dayOfWeek,
    hour_utc: hourUTC,
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    open_rate: 0,
    click_rate: 0,
    score: 0,
    ...extra,
  };
}

function wire(buckets: Record<string, number>[]): unknown {
  return {
    lookback_days: 90,
    generated_at: "2026-08-02T10:00:00Z",
    top_buckets: buckets,
    heatmap: buckets,
  };
}

describe("parseSendTimeAnalysis", () => {
  it("returns null for a payload that is not an analysis", () => {
    expect(parseSendTimeAnalysis(null)).toBeNull();
    expect(parseSendTimeAnalysis({})).toBeNull();
    expect(parseSendTimeAnalysis({ heatmap: "nope" })).toBeNull();
  });

  it("densifies a SPARSE heatmap by index, never by iteration order", () => {
    // The one bucket the server sent is Wednesday 09:00. A parser that pushed
    // rows in arrival order would put it at grid[0] and every cell after it
    // would render one position early.
    const analysis = parseSendTimeAnalysis(
      wire([wireBucket(3, 9, { sent: 100, delivered: 90, opened: 45, open_rate: 0.5 })]),
    );
    expect(analysis).not.toBeNull();
    expect(analysis!.grid).toHaveLength(BUCKETS_PER_WEEK);
    expect(bucketAt(analysis!, 3, 9)?.opened).toBe(45);
    expect(bucketAt(analysis!, 0, 0)?.opened).toBe(0);
    // Every cell knows its own coordinates, so the grid can be walked by index.
    expect(analysis!.grid[BUCKETS_PER_WEEK - 1]).toMatchObject({
      dayOfWeek: 6,
      hourUTC: 23,
    });
  });

  it("drops out-of-range coordinates rather than writing outside the grid", () => {
    const analysis = parseSendTimeAnalysis(
      wire([wireBucket(9, 9, { opened: 5 }), wireBucket(1, 99, { opened: 7 })]),
    );
    expect(analysis!.grid).toHaveLength(BUCKETS_PER_WEEK);
    expect(analysis!.grid.some((bucket) => bucket.opened > 0)).toBe(false);
  });

  it("keeps generated_at only when the server actually sent one", () => {
    expect(parseSendTimeAnalysis({ heatmap: [] })?.generatedAt).toBeNull();
    expect(parseSendTimeAnalysis(wire([]))?.generatedAt).toBe(
      "2026-08-02T10:00:00Z",
    );
  });
});

describe("bucketMetric — absence is not zero", () => {
  it("reports NO open rate for an hour that was never sent into", () => {
    const analysis = parseSendTimeAnalysis(wire([wireBucket(2, 3)]))!;
    const bucket = bucketAt(analysis, 2, 3)!;
    // The wire says open_rate: 0. That is the Go zero value, not a measurement.
    expect(bucket.openRate).toBe(0);
    expect(bucketMetric(bucket, "openRate")).toBeNull();
    expect(formatRate(bucketMetric(bucket, "openRate"))).toBe("—");
  });

  it("reports a REAL zero open rate for an hour that was sent into and died", () => {
    const analysis = parseSendTimeAnalysis(
      wire([wireBucket(2, 3, { sent: 500, delivered: 480 })]),
    )!;
    const bucket = bucketAt(analysis, 2, 3)!;
    expect(bucketMetric(bucket, "openRate")).toBe(0);
    expect(formatRate(bucketMetric(bucket, "openRate"))).toBe("0.0%");
  });

  it("falls back from delivered to sent, exactly as finalizeBucket does", () => {
    const analysis = parseSendTimeAnalysis(
      wire([wireBucket(4, 8, { sent: 200, delivered: 0, open_rate: 0.25 })]),
    )!;
    expect(bucketMetric(bucketAt(analysis, 4, 8)!, "openRate")).toBe(0.25);
  });

  it("scores a cell with audience signal and no send history", () => {
    // The single most useful cell on the grid: nobody has ever sent here, but
    // the per-subscriber model says the audience is awake.
    const analysis = parseSendTimeAnalysis(
      wire([wireBucket(1, 14, { subscriber_signal: 42, score: 0.042 })]),
    )!;
    const bucket = bucketAt(analysis, 1, 14)!;
    expect(bucketMetric(bucket, "openRate")).toBeNull();
    expect(bucketMetric(bucket, "score")).toBeCloseTo(0.042);
    expect(bucketMetric(bucket, "signal")).toBe(42);
  });

  it("has no score for a cell with neither sends nor signal", () => {
    const analysis = parseSendTimeAnalysis(wire([wireBucket(5, 5)]))!;
    expect(bucketMetric(bucketAt(analysis, 5, 5)!, "score")).toBeNull();
  });
});

describe("metricIsMeasurable", () => {
  it("is false for audience signal when the model has never run", () => {
    const analysis = parseSendTimeAnalysis(
      wire([wireBucket(1, 1, { sent: 10, delivered: 10, opened: 5, open_rate: 0.5 })]),
    )!;
    expect(metricIsMeasurable(analysis, "openRate")).toBe(true);
    // Every cell honestly reports zero modelled subscribers; a grid of honest
    // zeroes still must not be drawn as "nobody is ever awake".
    expect(metricIsMeasurable(analysis, "signal")).toBe(false);
  });

  it("is false for open rate when nothing has ever been sent", () => {
    const analysis = parseSendTimeAnalysis(
      wire([wireBucket(1, 1, { subscriber_signal: 12 })]),
    )!;
    expect(metricIsMeasurable(analysis, "openRate")).toBe(false);
    expect(metricIsMeasurable(analysis, "signal")).toBe(true);
  });
});

describe("rampIntensity", () => {
  it("keeps 'never measured' distinguishable from 'coldest'", () => {
    expect(rampIntensity(null, 1)).toBeNull();
    expect(rampIntensity(0, 1)).toBe(0);
  });

  it("scales to the peak and clamps", () => {
    expect(rampIntensity(0.5, 1)).toBe(0.5);
    expect(rampIntensity(2, 1)).toBe(1);
    expect(rampIntensity(1, 0)).toBe(0);
  });
});

describe("topWindows", () => {
  it("returns NOTHING for a workspace with no history", () => {
    // The server's own top_buckets would be twelve arbitrary all-zero rows
    // here, because sort.Slice over 168 equal scores is unstable and unfiltered.
    const analysis = parseSendTimeAnalysis(wire([]))!;
    expect(topWindows(analysis, "score")).toEqual([]);
    expect(analysisIsEmpty(analysis)).toBe(true);
  });

  it("ranks by the SELECTED metric, not by the server's score", () => {
    const analysis = parseSendTimeAnalysis(
      wire([
        wireBucket(1, 9, {
          sent: 100,
          delivered: 100,
          opened: 60,
          clicked: 1,
          open_rate: 0.6,
          click_rate: 0.01,
          score: 0.62,
        }),
        wireBucket(3, 17, {
          sent: 100,
          delivered: 100,
          opened: 20,
          clicked: 15,
          open_rate: 0.2,
          click_rate: 0.15,
          score: 0.5,
        }),
      ]),
    )!;
    expect(topWindows(analysis, "openRate").map((w) => w.bucket.hourUTC)).toEqual([
      9, 17,
    ]);
    expect(topWindows(analysis, "clickRate").map((w) => w.bucket.hourUTC)).toEqual([
      17, 9,
    ]);
    expect(topWindows(analysis, "score")[0]?.rank).toBe(1);
  });

  it("breaks ties deterministically so the list does not reshuffle", () => {
    const analysis = parseSendTimeAnalysis(
      wire([
        wireBucket(5, 20, { sent: 10, delivered: 10, opened: 5, open_rate: 0.5 }),
        wireBucket(2, 4, { sent: 10, delivered: 10, opened: 5, open_rate: 0.5 }),
        wireBucket(2, 4, { sent: 10, delivered: 10, opened: 5, open_rate: 0.5 }),
      ]),
    )!;
    const first = topWindows(analysis, "openRate");
    const second = topWindows(analysis, "openRate");
    expect(first.map(utcOf)).toEqual(second.map(utcOf));
    // Earlier in the week wins an otherwise exact tie.
    expect(first[0]?.bucket.dayOfWeek).toBe(2);
  });

  it("honours the limit", () => {
    const buckets = Array.from({ length: 10 }, (_, i) =>
      wireBucket(1, i, { sent: 10, delivered: 10, opened: i, open_rate: i / 10 }),
    );
    const analysis = parseSendTimeAnalysis(wire(buckets))!;
    expect(topWindows(analysis, "openRate", 3)).toHaveLength(3);
  });
});

function utcOf(window: { bucket: { dayOfWeek: number; hourUTC: number } }): string {
  return `${window.bucket.dayOfWeek}:${window.bucket.hourUTC}`;
}

describe("metricPeak and totals", () => {
  it("peaks on the largest measured value", () => {
    const analysis = parseSendTimeAnalysis(
      wire([
        wireBucket(0, 1, { sent: 10, delivered: 10, opened: 3, open_rate: 0.3 }),
        wireBucket(0, 2, { sent: 10, delivered: 10, opened: 9, open_rate: 0.9 }),
      ]),
    )!;
    expect(metricPeak(analysis, "openRate")).toBe(0.9);
  });

  it("sums the raw counts and counts only cells with send history", () => {
    const analysis = parseSendTimeAnalysis(
      wire([
        wireBucket(0, 1, { sent: 10, delivered: 9, opened: 3, clicked: 1 }),
        wireBucket(0, 2, { subscriber_signal: 7 }),
      ]),
    )!;
    expect(analysisTotals(analysis)).toEqual({
      sent: 10,
      delivered: 9,
      opened: 3,
      clicked: 1,
      modelledSubscribers: 7,
      measuredCells: 1,
    });
    expect(analysisIsEmpty(analysis)).toBe(false);
  });

  it("is empty only when there is neither send history nor a model", () => {
    const modelOnly = parseSendTimeAnalysis(
      wire([wireBucket(0, 0, { subscriber_signal: 1 })]),
    )!;
    expect(analysisIsEmpty(modelOnly)).toBe(false);
  });
});
