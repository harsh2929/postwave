import { describe, expect, it } from "vitest";

import {
  countDelta,
  neutralDelta,
  rateDelta,
  rateFromCounts,
  rateFromUniqueRecipients,
} from "./dashboardMetrics";

describe("rateFromCounts", () => {
  it("computes an honest ratio", () => {
    expect(rateFromCounts(125, 500)).toBe(0.25);
  });

  it("keeps a genuine measured zero", () => {
    expect(rateFromCounts(0, 500)).toBe(0);
  });

  it("refuses a ratio above 1 instead of clamping it into plausibility", () => {
    // opens > delivered means the denominator is wrong or lagging. Clamping to
    // 100% hides a data-integrity problem behind a believable number.
    expect(rateFromCounts(14, 10)).toBeNull();
  });

  it("refuses a zero, negative, or non-numeric denominator", () => {
    expect(rateFromCounts(5, 0)).toBeNull();
    expect(rateFromCounts(5, -1)).toBeNull();
    expect(rateFromCounts(5, null)).toBeNull();
    expect(rateFromCounts(5, undefined)).toBeNull();
    expect(rateFromCounts(-1, 5)).toBeNull();
    expect(rateFromCounts(Number.NaN, 5)).toBeNull();
  });
});

describe("rateFromUniqueRecipients", () => {
  it("prefers delivered and falls back to sent", () => {
    expect(rateFromUniqueRecipients(50, 200, 400)).toBe(0.25);
    expect(rateFromUniqueRecipients(50, 0, 200)).toBe(0.25);
    expect(rateFromUniqueRecipients(50, undefined, 200)).toBe(0.25);
  });

  it("returns null when neither denominator is usable", () => {
    expect(rateFromUniqueRecipients(50, 0, 0)).toBeNull();
  });
});

describe("countDelta", () => {
  it("signs the movement and formats the magnitude", () => {
    expect(countDelta(1200, 1000)).toEqual({
      dir: "up",
      text: "+200 vs prev",
    });
    expect(countDelta(900, 1000)?.dir).toBe("down");
    expect(countDelta(900, 1000)?.text).toBe("−100 vs prev");
  });

  it("says 'no change' rather than '+0'", () => {
    expect(countDelta(10, 10)).toEqual({ dir: "flat", text: "no change vs prev" });
  });

  it("returns null when there is no comparison window at all", () => {
    // "no previous period" and "unchanged" are different statements.
    expect(countDelta(10, null)).toBeNull();
    expect(countDelta(null, 10)).toBeNull();
    expect(countDelta(10, undefined)).toBeNull();
  });
});

describe("rateDelta", () => {
  it("reports rate movement in percentage points, not percent-of-percent", () => {
    expect(rateDelta(0.324, 0.3)).toEqual({
      dir: "up",
      text: "+2.4 pts vs prev",
    });
    expect(rateDelta(0.28, 0.3)?.text).toBe("−2.0 pts vs prev");
  });

  it("treats sub-noise movement as unchanged", () => {
    expect(rateDelta(0.30001, 0.3)?.dir).toBe("flat");
  });

  it("returns null with no comparison rate", () => {
    expect(rateDelta(0.3, null)).toBeNull();
  });
});

describe("neutralDelta", () => {
  it("drops the good/bad polarity but keeps the movement text", () => {
    expect(neutralDelta(rateDelta(0.02, 0.01))).toEqual({
      dir: "flat",
      text: "+1.0 pts vs prev",
    });
    expect(neutralDelta(null)).toBeNull();
  });
});
