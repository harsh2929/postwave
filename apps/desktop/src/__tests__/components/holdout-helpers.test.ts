/**
 * holdout-helpers — configuration coverage for composer/HoldoutCard.
 *
 * The legacy result mapper was removed: the campaign-level measurement panel
 * is now the only renderer and its discriminated union cannot carry a number
 * for an underpowered result.
 */

import { describe, expect, it } from "vitest";

import { clampHoldoutPercent } from "../../components/composer/holdout-helpers";

describe("formatting", () => {
  it("clampHoldoutPercent mirrors the server's 0..50 bound", () => {
    expect(clampHoldoutPercent(10)).toBe(10);
    expect(clampHoldoutPercent(75)).toBe(50);
    expect(clampHoldoutPercent(-3)).toBe(0);
    expect(clampHoldoutPercent(12.6)).toBe(13);
    expect(clampHoldoutPercent(Number.NaN)).toBe(0);
  });
});
