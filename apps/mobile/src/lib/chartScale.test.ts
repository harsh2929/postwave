import { describe, expect, it } from "vitest";

import {
  areaPath,
  extentOf,
  indexAtX,
  linePath,
  niceTicks,
  pathSegments,
  scaleX,
  scaleY,
  tickLabel,
} from "./chartScale";

describe("extentOf", () => {
  it("anchors count axes at zero so differences are not exaggerated", () => {
    // The single most common way a chart misleads: starting the axis at 40
    // makes 41 look twice as big as 40.
    expect(extentOf([40, 41, 42])).toEqual({ min: 0, max: 42 });
  });

  it("releases the zero anchor for genuinely signed series", () => {
    expect(extentOf([-3, 5], { zeroBased: false })).toEqual({ min: -3, max: 5 });
  });

  it("still includes zero when a zero-based series goes negative", () => {
    expect(extentOf([-3, 5])).toEqual({ min: -3, max: 5 });
  });

  it("pads a flat series instead of collapsing to a zero span", () => {
    const extent = extentOf([40, 40, 40], { zeroBased: false });
    expect(extent.max).toBeGreaterThan(extent.min);
  });

  it("survives an empty or all-null series", () => {
    expect(extentOf([])).toEqual({ min: 0, max: 1 });
    expect(extentOf([null, undefined, NaN])).toEqual({ min: 0, max: 1 });
  });
});

describe("scales", () => {
  it("inverts y — SVG's origin is top-left", () => {
    const extent = { min: 0, max: 100 };
    expect(scaleY(100, extent, 200)).toBe(0);
    expect(scaleY(0, extent, 200)).toBe(200);
    expect(scaleY(50, extent, 200)).toBe(100);
  });

  it("centers a flat series rather than dividing by zero", () => {
    expect(scaleY(5, { min: 5, max: 5 }, 200)).toBe(100);
  });

  it("centers a lone x point instead of pinning it to the left edge", () => {
    expect(scaleX(0, 1, 300)).toBe(150);
    expect(scaleX(0, 3, 300)).toBe(0);
    expect(scaleX(2, 3, 300)).toBe(300);
  });
});

describe("niceTicks", () => {
  it("lands on human numbers", () => {
    expect(niceTicks({ min: 0, max: 100 }, 4)).toEqual([0, 25, 50, 75, 100]);
  });

  it("does not emit float drift", () => {
    for (const tick of niceTicks({ min: 0, max: 1 }, 4)) {
      expect(String(tick)).not.toMatch(/0{6,}\d/);
    }
  });

  it("degrades safely on a zero span", () => {
    expect(niceTicks({ min: 5, max: 5 })).toEqual([5]);
  });
});

describe("pathSegments", () => {
  const extent = { min: 0, max: 10 };

  it("breaks the line at missing data instead of interpolating across it", () => {
    // A day with no send is not a measured zero and must not be drawn as a
    // straight line through the gap.
    const segments = pathSegments([1, 2, null, 8, 9], extent, 100, 50);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.startIndex).toBe(0);
    expect(segments[0]?.points).toHaveLength(2);
    expect(segments[1]?.startIndex).toBe(3);
    expect(segments[1]?.points).toHaveLength(2);
  });

  it("keeps a fully populated series as one run", () => {
    expect(pathSegments([1, 2, 3], extent, 100, 50)).toHaveLength(1);
  });

  it("returns nothing for an all-null series", () => {
    expect(pathSegments([null, null], extent, 100, 50)).toHaveLength(0);
  });

  it("treats a measured zero as data, not as a gap", () => {
    const segments = pathSegments([0, 0, 0], extent, 100, 50);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.points).toHaveLength(3);
  });
});

describe("paths", () => {
  it("emits a move-then-lines path", () => {
    expect(
      linePath([
        { x: 0, y: 10 },
        { x: 5, y: 0 },
      ]),
    ).toBe("M 0 10 L 5 0");
  });

  it("emits only a move for a lone point", () => {
    expect(linePath([{ x: 3, y: 4 }])).toBe("M 3 4");
  });

  it("closes an area down to the baseline", () => {
    const d = areaPath(
      [
        { x: 0, y: 10 },
        { x: 5, y: 0 },
      ],
      50,
    );
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain("L 5 50");
    expect(d).toContain("L 0 50");
  });

  it("refuses to fill an area under a single point", () => {
    expect(areaPath([{ x: 0, y: 10 }], 50)).toBe("");
  });
});

describe("indexAtX — touch scrubbing", () => {
  it("maps a touch to the nearest data index", () => {
    expect(indexAtX(0, 5, 100)).toBe(0);
    expect(indexAtX(100, 5, 100)).toBe(4);
    expect(indexAtX(50, 5, 100)).toBe(2);
  });

  it("clamps a drag past either edge", () => {
    expect(indexAtX(-40, 5, 100)).toBe(0);
    expect(indexAtX(400, 5, 100)).toBe(4);
  });

  it("survives a zero-width layout during first paint", () => {
    expect(indexAtX(10, 5, 0)).toBe(0);
  });
});

describe("a flat series at zero never implies negative values", () => {
  /**
   * `extentOf` padded a flat series symmetrically, so all zeroes produced
   * `{ min: -1, max: 1 }`: the axis ran 1 down to -1 and the chart filled the
   * band BELOW ZERO. On the suppressions screen that drew a pink region under
   * "Added · last 30 days" — a shape that reads as negative suppressions,
   * which cannot happen. Seen in-app on 2026-08-19.
   */
  it("keeps the floor at zero for an all-zero count series", () => {
    expect(extentOf([0, 0, 0, 0])).toEqual({ min: 0, max: 1 });
  });

  it("does the same for a single zero and for an empty series", () => {
    expect(extentOf([0])).toEqual({ min: 0, max: 1 });
    expect(extentOf([])).toEqual({ min: 0, max: 1 });
  });

  it("still centres a flat series when the axis is NOT zero-based", () => {
    // Off the zero-based path a flat line legitimately wants headroom on both
    // sides, and a negative floor is meaningful there.
    expect(extentOf([0, 0], { zeroBased: false })).toEqual({ min: -1, max: 1 });
  });

  it("leaves a flat POSITIVE series anchored at zero, as before", () => {
    expect(extentOf([5, 5, 5])).toEqual({ min: 0, max: 5 });
  });

  it("leaves a flat NEGATIVE series capped at zero, as before", () => {
    expect(extentOf([-3, -3])).toEqual({ min: -3, max: 0 });
  });

  it("does not disturb an ordinary mixed series", () => {
    expect(extentOf([0, 4, 2])).toEqual({ min: 0, max: 4 });
  });
});

describe("axis labels never collapse two gridlines into one text", () => {
  /**
   * Every tick was formatted with `compactNum`, which rounds to whole numbers.
   * A 0-1 domain yields ticks [0, 0.5, 1] and printed "0", "0", "1" -- two
   * distinct gridlines wearing the same label. Seen on the suppressions chart
   * on 2026-08-19, exposed by anchoring an all-zero series at a 0-1 domain.
   */
  const compact = (v: number) => String(Math.round(v));

  it("gives every tick of a 0-1 axis a distinct label", () => {
    const ticks = niceTicks({ min: 0, max: 1 }, 3);
    const labels = ticks.map((t) => tickLabel(t, ticks, compact));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("uses whole numbers when the step is 1 or more", () => {
    const ticks = [0, 5, 10];
    expect(ticks.map((t) => tickLabel(t, ticks, compact))).toEqual(["0", "5", "10"]);
  });

  it("shows one decimal for a half step and two for a quarter step", () => {
    expect(tickLabel(0.5, [0, 0.5, 1], compact)).toBe("0.5");
    expect(tickLabel(0.25, [0, 0.25, 0.5], compact)).toBe("0.25");
  });

  it("falls back to the compact formatter for a single tick", () => {
    expect(tickLabel(7, [7], compact)).toBe("7");
  });
});
