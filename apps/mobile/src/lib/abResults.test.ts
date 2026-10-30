import { describe, expect, it } from "vitest";

import { abComparisonKey } from "./abResults";

describe("abComparisonKey", () => {
  it("matches the backend's label-keyed pairwise maps", () => {
    expect(abComparisonKey("B", 1)).toBe("control_vs_B");
  });

  it("falls back to the variant index when no label exists", () => {
    expect(abComparisonKey("", 2)).toBe("control_vs_2");
  });
});
