// Tests for the pure logic behind the Surfacing Analytics engagement
// panel (#3). These are load-bearing for honest-UI: the inflation delta
// must never read negative, the AI-surfacing label must never upgrade a
// low/unknown score into a flattering bucket, and the human-row gate must
// hide the bot-stripped row when there is no real filtering signal.

import { describe, expect, it } from "vitest";

import {
  aiSurfacingLabel,
  formatInflationDelta,
  shouldShowHumanRow,
} from "../lib/engagement-helpers";

describe("formatInflationDelta", () => {
  it("formats a normal positive inflation in percentage points", () => {
    // raw 0.42, human 0.388 → 3.2pp
    expect(formatInflationDelta(0.42, 0.388)).toBe("3.2pp bot inflation");
  });
  it("clamps to 0.0pp when human rate exceeds raw (never negative)", () => {
    expect(formatInflationDelta(0.3, 0.5)).toBe("0.0pp");
  });
  it("returns 0.0pp when both rates are zero", () => {
    expect(formatInflationDelta(0, 0)).toBe("0.0pp");
  });
  it("returns 0.0pp on exact equality", () => {
    expect(formatInflationDelta(0.5, 0.5)).toBe("0.0pp");
  });
  it("treats non-finite / missing inputs as 0", () => {
    expect(formatInflationDelta(Number.NaN, 0.1)).toBe("0.0pp");
    expect(formatInflationDelta(0.4, null)).toBe("40.0pp bot inflation");
    expect(formatInflationDelta(undefined, undefined)).toBe("0.0pp");
  });
});

describe("aiSurfacingLabel", () => {
  it("buckets scores into Low / Moderate / High", () => {
    expect(aiSurfacingLabel(0)).toBe("Low");
    expect(aiSurfacingLabel(0.39)).toBe("Low");
    expect(aiSurfacingLabel(0.4)).toBe("Moderate");
    expect(aiSurfacingLabel(0.69)).toBe("Moderate");
    expect(aiSurfacingLabel(0.7)).toBe("High");
    expect(aiSurfacingLabel(1.0)).toBe("High");
  });
  it("floors non-finite / missing scores to Low (never flatters)", () => {
    expect(aiSurfacingLabel(Number.NaN)).toBe("Low");
    expect(aiSurfacingLabel(null)).toBe("Low");
    expect(aiSurfacingLabel(undefined)).toBe("Low");
  });
});

describe("shouldShowHumanRow", () => {
  it("is false when no human opens and no bot signatures", () => {
    expect(
      shouldShowHumanRow({ human_unique_opens: 0, bot_signatures_applied: [] }),
    ).toBe(false);
  });
  it("is true when there are human opens", () => {
    expect(
      shouldShowHumanRow({
        human_unique_opens: 12,
        bot_signatures_applied: [],
      }),
    ).toBe(true);
  });
  it("is true when a bot signature fired even with zero human opens", () => {
    expect(
      shouldShowHumanRow({
        human_unique_opens: 0,
        bot_signatures_applied: ["Apple MPP"],
      }),
    ).toBe(true);
  });
  it("is false for null / undefined panels", () => {
    expect(shouldShowHumanRow(null)).toBe(false);
    expect(shouldShowHumanRow(undefined)).toBe(false);
  });
  it("tolerates a malformed bot_signatures_applied", () => {
    expect(
      shouldShowHumanRow({
        human_unique_opens: 0,
        // @ts-expect-error — exercising a malformed payload defensively
        bot_signatures_applied: null,
      }),
    ).toBe(false);
  });
});
