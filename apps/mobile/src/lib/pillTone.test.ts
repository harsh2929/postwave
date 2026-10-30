/**
 * pillTone.test.ts — the edges of the pill colour resolver and of the ink
 * helper it stands on. The palette-wide contrast matrix lives in
 * themeContrast.test.ts, and the rendered component in Pill.test.tsx.
 */
import { describe, expect, it } from "vitest";
import { dark, light } from "@postwave/design-tokens";

import { legibleInkOnTint } from "./color";
import { blendOver, contrastRatio, parseHex } from "./contrast";
import { pillColors, type PillTone } from "./pillTone";
import type { ThemeTokens } from "./theme";

describe("pillColors", () => {
  it("reads an unknown tone as neutral, as the old ternary chain did", () => {
    // Callers cast server statuses to PillTone; the last `else` was fgMuted.
    const unknown = pillColors(light, "paused" as PillTone);
    expect(unknown).toEqual(pillColors(light, "neutral"));
    expect(unknown.tint).toBe(light.fgMuted);
  });

  it("paints the tone as before when the theme cannot be measured", () => {
    // A partial theme (many component tests mock useTheme with two tokens)
    // must not turn a label transparent or a wash invalid.
    const partial = { danger: "#D43C1F" } as unknown as ThemeTokens;
    expect(pillColors(partial, "danger")).toEqual({
      tint: "#D43C1F",
      wash: "rgba(212,60,31,0.15)",
      ink: "#D43C1F",
    });
  });

  it("resolves each palette and tone once", () => {
    expect(pillColors(dark, "accent")).toBe(pillColors(dark, "accent"));
    expect(pillColors(dark, "accent")).not.toBe(pillColors(light, "accent"));
  });
});

describe("legibleInkOnTint", () => {
  const onWhite = {
    tint: "#D43C1F",
    alpha: 0.15,
    grounds: ["#FFFFFF"],
    toward: "#0F0F0F",
    min: 4.5,
  };

  it("keeps an ink that already clears", () => {
    expect(legibleInkOnTint({ ...onWhite, ink: "#0F0F0F" })).toBe("#0F0F0F");
  });

  it("walks a failing ink toward the target until it clears, keeping its hue", () => {
    const wash = blendOver(onWhite.tint, "#FFFFFF", onWhite.alpha);
    expect(contrastRatio(onWhite.tint, wash)).toBeLessThan(4.5);
    const ink = legibleInkOnTint({ ...onWhite, ink: onWhite.tint });
    expect(contrastRatio(ink, wash)).toBeGreaterThanOrEqual(4.5);
    expect(ink.toLowerCase()).not.toBe(onWhite.toward.toLowerCase());
    const [r, g, b] = parseHex(ink) ?? [0, 0, 0];
    // Still red, not a neutral dark grey.
    expect(r - Math.max(g, b)).toBeGreaterThan(0x60);
  });

  it("clears against the WORST ground, not the first", () => {
    const grounds = ["#FFFFFF", "#F2F0EA"];
    const ink = legibleInkOnTint({ ...onWhite, grounds, ink: onWhite.tint });
    for (const ground of grounds) {
      const wash = blendOver(onWhite.tint, ground, onWhite.alpha);
      expect(contrastRatio(ink, wash), ground).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("returns the ink untouched when a colour cannot be measured", () => {
    const ink = onWhite.tint;
    expect(legibleInkOnTint({ ...onWhite, ink, grounds: ["rgb(1,2,3)"] })).toBe(ink);
    expect(legibleInkOnTint({ ...onWhite, ink, grounds: [] })).toBe(ink);
    expect(legibleInkOnTint({ ...onWhite, ink, toward: "rgba(0,0,0,1)" })).toBe(ink);
  });

  it("is never harder to read than the ink it was given", () => {
    // No step can reach 30:1, so it returns the most legible step, which is
    // the far end when the target is on the right side of the wash...
    expect(
      legibleInkOnTint({ ...onWhite, ink: onWhite.tint, min: 30 }),
    ).toBe("#0f0f0f");
    // ...and the ink itself when every step would make it worse.
    expect(
      legibleInkOnTint({
        ...onWhite,
        ink: "#333333",
        toward: "#FFFFFF",
        min: 30,
      }),
    ).toBe("#333333");
  });
});
