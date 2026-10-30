import { describe, expect, it } from "vitest";

import { sparklinePoints } from "./sparkline";

describe("sparklinePoints", () => {
  it("centers constant-valued series instead of pinning them to the bottom", () => {
    const points = sparklinePoints([4, 4, 4], 100, 50, 2, 2);

    expect(points.map((point) => point.y)).toEqual([25, 25, 25]);
  });

  it("keeps variable series within the padded chart bounds", () => {
    const points = sparklinePoints([0, 5, 10], 100, 50, 2, 2);

    expect(points[0]?.y).toBe(48);
    expect(points[2]?.y).toBe(2);
  });
});
