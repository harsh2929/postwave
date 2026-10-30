import { describe, expect, it } from "vitest";

import { bucketAt, parseSendTimeAnalysis } from "./sendTimeAnalysis";
import {
  formatMetric,
  localWindowLabel,
  projectHourToLocal,
  utcWindowLabel,
} from "./sendTimeLabels";

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
    heatmap: buckets,
  };
}

describe("projectHourToLocal", () => {
  it("is the identity at UTC", () => {
    expect(projectHourToLocal(3, 14, 0)).toEqual({
      weekday: 3,
      hour: 14,
      minute: 0,
    });
  });

  it("handles half-hour zones without rounding the minutes away", () => {
    // Asia/Kolkata is +05:30. Wednesday 14:00 UTC is Wednesday 19:30 local.
    expect(projectHourToLocal(3, 14, 330)).toEqual({
      weekday: 3,
      hour: 19,
      minute: 30,
    });
    // Kathmandu is +05:45.
    expect(projectHourToLocal(3, 14, 345)).toEqual({
      weekday: 3,
      hour: 19,
      minute: 45,
    });
  });

  it("wraps forward across the week boundary", () => {
    // Saturday 23:00 UTC is Sunday 08:00 in Tokyo (+09:00).
    expect(projectHourToLocal(6, 23, 540)).toEqual({
      weekday: 0,
      hour: 8,
      minute: 0,
    });
  });

  it("wraps backward across the week boundary", () => {
    // Sunday 02:00 UTC is Saturday 21:00 in New York (-05:00).
    expect(projectHourToLocal(0, 2, -300)).toEqual({
      weekday: 6,
      hour: 21,
      minute: 0,
    });
  });
});

describe("labels", () => {
  const analysis = parseSendTimeAnalysis(
    wire([wireBucket(2, 14, { sent: 1, delivered: 1, opened: 1, open_rate: 1 })]),
  )!;
  const bucket = bucketAt(analysis, 2, 14)!;

  it("names the UTC bucket the API actually returned", () => {
    expect(utcWindowLabel(bucket)).toBe("Tue 14:00 UTC");
  });

  it("names the local instant a human would recognise", () => {
    expect(localWindowLabel(bucket, -300)).toBe("Tuesday 09:00");
    expect(localWindowLabel(bucket, 330)).toBe("Tuesday 19:30");
  });

  it("formats each metric in its own units", () => {
    expect(formatMetric(0.3421, "openRate")).toBe("34.2%");
    expect(formatMetric(41.6, "signal")).toBe("42");
    expect(formatMetric(0.6231, "score")).toBe("0.623");
    expect(formatMetric(null, "signal")).toBe("—");
  });
});
