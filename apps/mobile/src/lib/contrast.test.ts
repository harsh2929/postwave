import { describe, expect, it } from "vitest";
import { dark, light } from "@postwave/design-tokens";

import {
  NON_TEXT_CONTRAST_MIN,
  SKELETON_PARKED_ALPHA,
  SKELETON_FILL_TOKEN,
  STAT_CARD_SKELETON_TOKEN,
  blendOver,
  contrastRatio,
  parseHex,
  relativeLuminance,
} from "./contrast";

describe("contrast arithmetic", () => {
  it("matches the WCAG reference endpoints", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
    // Order-independent: contrast is a ratio between two luminances.
    expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(
      contrastRatio("#FFFFFF", "#767676"),
      10,
    );
  });

  it("refuses colours it cannot parse instead of inventing a number", () => {
    expect(parseHex("rgba(0,0,0,0.5)")).toBeNull();
    expect(parseHex("#abc")).toBeNull();
    expect(Number.isNaN(relativeLuminance("not a colour"))).toBe(true);
    expect(Number.isNaN(contrastRatio("#000000", "nope"))).toBe(true);
  });

  it("composites a translucent colour over its background", () => {
    expect(blendOver("#FFFFFF", "#000000", 0)).toBe("#000000");
    expect(blendOver("#FFFFFF", "#000000", 1)).toBe("#ffffff");
    expect(blendOver("#FFFFFF", "#000000", 0.5)).toBe("#808080");
    // An unparseable input degrades to the foreground rather than throwing.
    expect(blendOver("rgba(1,2,3,0.4)", "#000000", 0.5)).toBe(
      "rgba(1,2,3,0.4)",
    );
  });
});

describe("stat-tile loading bar is visible in both shipped palettes", () => {
  const palettes = { dark, light } as const;

  it("clears the non-text contrast floor at the pulse's parked opacity", () => {
    for (const [name, palette] of Object.entries(palettes)) {
      const composite = blendOver(
        palette[STAT_CARD_SKELETON_TOKEN],
        palette.surface,
        SKELETON_PARKED_ALPHA,
      );
      const ratio = contrastRatio(composite, palette.surface);
      expect(
        ratio,
        `${name}: ${STAT_CARD_SKELETON_TOKEN} over surface measured ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_MIN);
    }
  });

  it("documents why the previous two candidates were not fixes", () => {
    // The bug this file exists for: in the dark palette `borderSubtle` and
    // `surfaceElevated` are literally the same colour, so "moved off
    // surfaceElevated onto borderSubtle" changed nothing at all.
    expect(dark.borderSubtle).toBe(dark.surfaceElevated);
    for (const [name, palette] of Object.entries(palettes)) {
      for (const token of ["borderSubtle", "surfaceElevated"] as const) {
        const ratio = contrastRatio(
          blendOver(palette[token], palette.surface, SKELETON_PARKED_ALPHA),
          palette.surface,
        );
        expect(
          ratio,
          `${name}/${token} would measure ${ratio.toFixed(2)}:1`,
        ).toBeLessThan(NON_TEXT_CONTRAST_MIN);
      }
    }
  });
});

describe("EVERY skeleton is visible, not just the stat tile", () => {
  // The original bug was fixed in one component while `Skeleton` kept
  // defaulting every other screen to the invisible token. This asserts the
  // shared default, so a loading list can never again read as an empty one.
  const palettes = { light, dark };

  it("clears the non-text floor for the shared Skeleton fill in both palettes", () => {
    for (const [name, palette] of Object.entries(palettes)) {
      const ratio = contrastRatio(
        palette[SKELETON_FILL_TOKEN],
        palette.surface,
      );
      expect(
        ratio,
        `${name}: ${SKELETON_FILL_TOKEN} over surface measured ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_MIN);
    }
  });

  it("proves the OLD token would fail — so this test can actually catch it", () => {
    // borderSubtle === surfaceElevated (#242424) in dark; 1.12:1 on surface.
    expect(contrastRatio(dark.borderSubtle, dark.surface)).toBeLessThan(
      NON_TEXT_CONTRAST_MIN,
    );
  });
});
