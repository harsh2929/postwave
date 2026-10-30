/**
 * The scoped send-time week's parse rules and refusal handling.
 *
 * Three defects this pins, each of which renders a plausible-looking week that
 * is wrong rather than an obvious failure:
 *
 *   1. `secondary_dow` / `secondary_hour` are `omitempty` while
 *      `has_secondary_window` is not, so a real Sunday-00:00 second window
 *      arrives with both coordinates missing. Reading the coordinates as the
 *      authority silently deletes it.
 *   2. A modelled ZERO is a measurement here (the grid is normalised over all
 *      168 cells), unlike the tenant grid where a zero can mean "never sent".
 *      Treating it as unknown would blank half the week.
 *   3. The 404 body is `{"error":"insufficient_data","message":"…"}` with a
 *      BARE STRING error — not the usual `{error:{code,message}}` frame — so
 *      nothing downstream recovers a code from it and this parser must.
 */
import { describe, expect, it } from "vitest";

import {
  parseSegmentSendTimePattern,
  segmentCellAt,
  segmentDayPeak,
  segmentGridPeak,
  segmentHeatmapRefusal,
  segmentSampleSentence,
  segmentWindowLocalLabel,
  segmentWindowUtcLabel,
  SEGMENT_HEATMAP_CELLS,
} from "./sendTimeSegmentHeatmap";

function grid(fill: (day: number, hour: number) => number): number[][] {
  return Array.from({ length: 7 }, (_r, day) =>
    Array.from({ length: 24 }, (_c, hour) => fill(day, hour)),
  );
}

describe("parseSegmentSendTimePattern", () => {
  it("reads the wire shape into a flat 168-cell week", () => {
    const pattern = parseSegmentSendTimePattern({
      segment_id: "seg-1",
      subscribers_with_data: 412,
      grid: grid((day, hour) => (day === 2 && hour === 14 ? 0.09 : 0.001)),
      best_dow: 2,
      best_hour: 14,
      has_secondary_window: false,
      computed_at: "2026-09-03T10:00:00Z",
    });
    expect(pattern).not.toBeNull();
    expect(pattern!.segmentId).toBe("seg-1");
    expect(pattern!.subscribersWithData).toBe(412);
    expect(pattern!.grid).toHaveLength(SEGMENT_HEATMAP_CELLS);
    expect(segmentCellAt(pattern!, 2, 14)).toBe(0.09);
    expect(pattern!.best).toEqual({ dayOfWeek: 2, hourUTC: 14 });
    expect(pattern!.secondary).toBeNull();
    expect(pattern!.computedAt).toBe("2026-09-03T10:00:00Z");
  });

  it("keeps a Sunday-midnight second window that omitempty stripped", () => {
    // `has_secondary_window: true` with BOTH coordinates absent is exactly what
    // Go emits for dow=0, hour=0. The flag is the authority; the coordinates
    // default to 0 rather than the window disappearing.
    const pattern = parseSegmentSendTimePattern({
      grid: grid(() => 0.005),
      has_secondary_window: true,
    });
    expect(pattern!.secondary).toEqual({ dayOfWeek: 0, hourUTC: 0 });
  });

  it("drops a second window the server did not claim, coordinates or not", () => {
    const pattern = parseSegmentSendTimePattern({
      grid: grid(() => 0.005),
      secondary_dow: 4,
      secondary_hour: 9,
    });
    expect(pattern!.secondary).toBeNull();
  });

  it("keeps a modelled zero as a measurement, not an unknown", () => {
    const pattern = parseSegmentSendTimePattern({ grid: grid(() => 0) });
    expect(segmentCellAt(pattern!, 3, 3)).toBe(0);
    expect(pattern!.grid.every((cell) => cell === 0)).toBe(true);
    expect(segmentGridPeak(pattern!)).toBe(0);
  });

  it("marks a malformed row unknown without losing the rest of the week", () => {
    const rows = grid(() => 0.01);
    const pattern = parseSegmentSendTimePattern({
      grid: [rows[0], "not a row", ...rows.slice(2)],
    });
    expect(segmentCellAt(pattern!, 1, 0)).toBeNull();
    expect(segmentDayPeak(pattern!, 1)).toBeNull();
    expect(segmentCellAt(pattern!, 0, 0)).toBe(0.01);
    expect(segmentDayPeak(pattern!, 0)).toEqual({ hourUTC: 0, value: 0.01 });
  });

  it("clamps out-of-range coordinates instead of indexing off the week", () => {
    const pattern = parseSegmentSendTimePattern({
      grid: grid(() => 0.01),
      best_dow: 99,
      best_hour: -4,
    });
    expect(pattern!.best).toEqual({ dayOfWeek: 6, hourUTC: 0 });
  });

  it("returns null when there is no grid at all — an unreadable answer is not an empty week", () => {
    expect(parseSegmentSendTimePattern(null)).toBeNull();
    expect(parseSegmentSendTimePattern({ subscribers_with_data: 40 })).toBeNull();
    expect(parseSegmentSendTimePattern({ grid: "<!doctype html>" })).toBeNull();
  });
});

describe("segmentGridPeak / segmentDayPeak", () => {
  it("scales the ramp against the brightest measured cell", () => {
    const pattern = parseSegmentSendTimePattern({
      grid: grid((day, hour) => (day === 5 && hour === 20 ? 0.4 : 0.002)),
    });
    expect(segmentGridPeak(pattern!)).toBe(0.4);
    expect(segmentDayPeak(pattern!, 5)).toEqual({ hourUTC: 20, value: 0.4 });
  });
});

describe("segmentHeatmapRefusal", () => {
  it("recovers the code and the server's sentence from the bare-string 404", () => {
    expect(
      segmentHeatmapRefusal(404, {
        error: "insufficient_data",
        message: "need >= 30 subscribers with open history; have 4",
      }),
    ).toEqual({
      code: "insufficient_data",
      message: "need >= 30 subscribers with open history; have 4",
    });
  });

  it("keeps the code when the server sent no sentence", () => {
    expect(segmentHeatmapRefusal(404, { error: "campaign_not_found" })).toEqual({
      code: "campaign_not_found",
      message: null,
    });
  });

  it("is not an answer for any other status, or for a framed envelope", () => {
    expect(
      segmentHeatmapRefusal(500, { error: "insufficient_data" }),
    ).toBeNull();
    expect(
      segmentHeatmapRefusal(404, { error: { code: "not_found", message: "x" } }),
    ).toBeNull();
    expect(segmentHeatmapRefusal(404, null)).toBeNull();
  });
});

describe("window labels", () => {
  it("prints the UTC coordinate the server reported", () => {
    expect(segmentWindowUtcLabel({ dayOfWeek: 2, hourUTC: 14 })).toBe(
      "Tue 14:00 UTC",
    );
  });

  it("projects into the device week, half-hour zones included", () => {
    // +05:30 — the zone an hour-granular conversion silently mangles.
    expect(segmentWindowLocalLabel({ dayOfWeek: 2, hourUTC: 14 }, 330)).toBe(
      "Tuesday 19:30",
    );
    // Wrapping backwards across the week boundary.
    expect(segmentWindowLocalLabel({ dayOfWeek: 0, hourUTC: 1 }, -180)).toBe(
      "Saturday 22:00",
    );
  });
});

describe("segmentSampleSentence", () => {
  it("says the server's own denominator, singular and plural", () => {
    const one = parseSegmentSendTimePattern({
      grid: grid(() => 0.01),
      subscribers_with_data: 1,
    });
    expect(segmentSampleSentence(one!)).toBe(
      "Averaged over 1 subscriber with open history.",
    );
    const many = parseSegmentSendTimePattern({
      grid: grid(() => 0.01),
      subscribers_with_data: 1412,
    });
    expect(segmentSampleSentence(many!)).toBe(
      "Averaged over 1,412 subscribers with open history.",
    );
  });
});
