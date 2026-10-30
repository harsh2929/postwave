/**
 * Tests for the SendTimeHeatmap accessibility helpers
 * (gap feature: sto-heatmap-a11y).
 *
 * The visible heatmap is a colour-only signal — without these helpers
 * a screen-reader user gets bare <div>s and no way to know where the
 * peak engagement window is. We pin the helpers so future refactors
 * can't silently drop the SR summary or change the spoken hour format.
 *
 * Bug surfaces this protects:
 *   - Zero-valued cells leaking into "top hour" output (cold-start
 *     heatmaps would otherwise announce "peak Sunday 12 AM" on every
 *     fresh tenant).
 *   - `fmtHourLong` producing "0 AM" or "13 PM" if the AM/PM math gets
 *     refactored (common off-by-one trap with `h % 12`).
 *   - Tie ordering churn — if Array.sort were unstable the same grid
 *     could announce a different "top hour" between renders, which is
 *     disorienting for SR users.
 */

import { describe, expect, it } from "vitest";

import {
  buildHeatmapSummary,
  DOW_LONG_LABELS,
  fmtHourLong,
  topCells,
} from "../components/sendtime/a11y";

describe("fmtHourLong — screen-reader friendly hour labels", () => {
  it("renders midnight as 12 AM, not 0 AM", () => {
    expect(fmtHourLong(0)).toBe("12 AM");
  });

  it("renders noon as 12 PM, not 0 PM or 12 AM", () => {
    expect(fmtHourLong(12)).toBe("12 PM");
  });

  it("renders 1 PM in 12-hour form (not 13 PM)", () => {
    expect(fmtHourLong(13)).toBe("1 PM");
  });

  it("renders 11 PM correctly", () => {
    expect(fmtHourLong(23)).toBe("11 PM");
  });

  it("renders 9 AM correctly (the audit's example peak)", () => {
    expect(fmtHourLong(9)).toBe("9 AM");
  });

  it("retains fractional timezone minutes in spoken labels", () => {
    expect(fmtHourLong(9, 30)).toBe("9:30 AM");
    expect(fmtHourLong(23, 45)).toBe("11:45 PM");
  });

  it("falls back to 'unknown hour' for out-of-range input", () => {
    expect(fmtHourLong(-1)).toBe("unknown hour");
    expect(fmtHourLong(24)).toBe("unknown hour");
    expect(fmtHourLong(Number.NaN)).toBe("unknown hour");
  });
});

describe("topCells — peak-hour extraction for SR summary", () => {
  function emptyGrid(): number[][] {
    return Array.from({ length: 7 }, () => Array(24).fill(0));
  }

  it("returns an empty list for an all-zero grid", () => {
    // Cold-start tenants: no opens yet. We must NOT announce a fake
    // peak — the screen reader should hear "no engagement yet".
    expect(topCells(emptyGrid(), 3)).toEqual([]);
  });

  it("excludes zero-valued cells even when N is large", () => {
    const g = emptyGrid();
    g[2][9] = 5; // Tuesday 9 AM
    g[4][14] = 3; // Thursday 2 PM
    const top = topCells(g, 10);
    expect(top).toHaveLength(2);
    expect(top.every((c) => c.value > 0)).toBe(true);
  });

  it("returns the highest-value cells in descending value order", () => {
    const g = emptyGrid();
    g[1][8] = 2;
    g[2][9] = 7; // peak
    g[5][20] = 4;
    const top = topCells(g, 3);
    expect(top[0]).toEqual({ dow: 2, hour: 9, value: 7 });
    expect(top[1]).toEqual({ dow: 5, hour: 20, value: 4 });
    expect(top[2]).toEqual({ dow: 1, hour: 8, value: 2 });
  });

  it("respects N when more cells are non-zero than requested", () => {
    const g = emptyGrid();
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        g[d][h] = d * 24 + h;
      }
    }
    expect(topCells(g, 3)).toHaveLength(3);
    // The peak in a strictly-increasing grid is Saturday 11 PM.
    expect(topCells(g, 1)[0]).toEqual({ dow: 6, hour: 23, value: 167 });
  });

  it("breaks ties with stable order (earlier cells win)", () => {
    // Stable ordering is what keeps the spoken "top hour" consistent
    // across renders of the same data. If sort were unstable a screen
    // reader user could hear a different peak each refresh.
    const g = emptyGrid();
    g[0][0] = 5;
    g[6][23] = 5;
    const top = topCells(g, 2);
    expect(top[0]).toEqual({ dow: 0, hour: 0, value: 5 });
    expect(top[1]).toEqual({ dow: 6, hour: 23, value: 5 });
  });

  it("tolerates a malformed grid without throwing", () => {
    // Defensive: parent components sometimes pass an undefined grid
    // while loading. The component coerces to [] but the helper must
    // also survive being called directly with that shape.
    expect(topCells(undefined as unknown as number[][], 3)).toEqual([]);
    const ragged = [[1, 2], undefined as unknown as number[], [3]];
    expect(topCells(ragged, 5)).toEqual([
      { dow: 2, hour: 0, value: 3 },
      { dow: 0, hour: 1, value: 2 },
      { dow: 0, hour: 0, value: 1 },
    ]);
  });

  it("filters out NaN and non-finite cell values", () => {
    const g = emptyGrid();
    g[3][3] = Number.NaN;
    g[3][4] = Number.POSITIVE_INFINITY;
    g[3][5] = 2;
    const top = topCells(g, 3);
    expect(top).toEqual([{ dow: 3, hour: 5, value: 2 }]);
  });

  it("returns an empty list when N is zero or negative", () => {
    const g = emptyGrid();
    g[0][0] = 1;
    expect(topCells(g, 0)).toEqual([]);
    expect(topCells(g, -2)).toEqual([]);
  });
});

describe("buildHeatmapSummary — wrapper aria-label", () => {
  it("matches the audit's reference phrasing", () => {
    // The implementation sketch specified
    //   "Engagement by day of week and hour, peak Tuesday 9am UTC"
    // We use the longer-form "9 AM" because it's how screen readers
    // pronounce it correctly, but the structure mirrors the sketch.
    const summary = buildHeatmapSummary([{ dow: 2, hour: 9, value: 7 }], "UTC");
    expect(summary).toContain("Tuesday");
    expect(summary).toContain("9 AM");
    expect(summary).toContain("UTC");
    expect(summary).toContain("Peak");
  });

  it("falls back to a no-data phrasing on an empty top list", () => {
    const summary = buildHeatmapSummary([], "UTC");
    expect(summary).toContain("No engagement recorded yet");
    // Must still describe the chart so the wrapper conveys its
    // purpose even with no data.
    expect(summary).toContain("Engagement heatmap");
  });

  it("respects the supplied tz label", () => {
    const summary = buildHeatmapSummary(
      [{ dow: 1, hour: 13, value: 4 }],
      "Local PST",
    );
    expect(summary).toContain("Monday");
    expect(summary).toContain("1 PM");
    expect(summary).toContain("Local PST");
  });

  it("includes an exact fractional offset minute in the peak summary", () => {
    const summary = buildHeatmapSummary(
      [{ dow: 2, hour: 9, value: 7 }],
      "Kolkata (GMT+05:30)",
      30,
    );
    expect(summary).toContain("9:30 AM");
    expect(summary).toContain("GMT+05:30");
  });
});

describe("DOW_LONG_LABELS — Sunday-first ordering matches backend", () => {
  it("places Sunday at index 0 (Go server convention)", () => {
    // The backend emits grid[dow][hour] with Sunday=0; the labels
    // table is what binds dow indices to spoken names. If this ever
    // drifted from the server, SR users would hear the wrong day for
    // every peak.
    expect(DOW_LONG_LABELS[0]).toBe("Sunday");
    expect(DOW_LONG_LABELS[6]).toBe("Saturday");
    expect(DOW_LONG_LABELS).toHaveLength(7);
  });
});
