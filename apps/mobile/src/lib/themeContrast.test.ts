/**
 * themeContrast.test.ts — the palette `lib/theme.ts` hands every screen,
 * measured instead of eyeballed.
 *
 * `contrast.test.ts` guards the ONE pairing that has already caused a shipped
 * bug (the skeleton fill). This file guards the pairings the rest of the app
 * paints text with, in BOTH shipped palettes, so a token tweak in
 * @postwave/design-tokens cannot quietly make a screen unreadable on one
 * theme while looking fine on the other — which is exactly how the original
 * mistake happened (checked by eye, on a light-mode simulator).
 *
 * WCAG 2.2: 4.5:1 for normal text (SC 1.4.3), 3:1 for large/bold text and for
 * non-text UI components (SC 1.4.11).
 */
import { describe, expect, it } from "vitest";
import { dark, light } from "@postwave/design-tokens";

import { withAlpha } from "./color";
import { NON_TEXT_CONTRAST_MIN, blendOver, contrastRatio } from "./contrast";
import { PILL_WASH_ALPHA, pillColors, type PillTone } from "./pillTone";

const NORMAL_TEXT_MIN = 4.5;
const LARGE_TEXT_MIN = 3;

const palettes = { light, dark } as const;
type TokenKey = keyof typeof light;

/** Every foreground/background pair a screen may use for body-sized text. */
const TEXT_PAIRS: [TokenKey, TokenKey][] = [
  ["fg", "bg"],
  ["fg", "bgSubtle"],
  ["fg", "surface"],
  ["fg", "surfaceElevated"],
  ["fgMuted", "bg"],
  ["fgMuted", "bgSubtle"],
  ["fgMuted", "surface"],
  ["fgMuted", "surfaceElevated"],
  ["accent", "bg"],
  ["accent", "surface"],
  ["accentFg", "accent"],
  // Destructive filled controls use the canvas token as their inverse ink:
  // warm paper in light mode, near-black ink in dark mode.
  ["bg", "danger"],
  ["danger", "bg"],
  ["danger", "surface"],
  ["warning", "bg"],
  ["warning", "surface"],
  ["success", "bg"],
  ["success", "surface"],
  ["info", "bg"],
  ["info", "surface"],
];

/**
 * Pairs that DO NOT clear the normal-text floor today, with the value each one
 * measured at when this was written. They are pinned at the large-text floor
 * so they cannot get worse, and the assertion below fails if one is IMPROVED —
 * that is the prompt to promote it into TEXT_PAIRS rather than let this list
 * rot into a lie.
 */
const BELOW_NORMAL_TEXT: {
  palette: "light" | "dark";
  pair: [TokenKey, TokenKey];
  measured: number;
}[] = [
  // Tertiary text (timestamps) on the warm-paper page background.
  { palette: "light", pair: ["fgSubtle", "bg"], measured: 4.41 },
  { palette: "light", pair: ["fgSubtle", "bgSubtle"], measured: 3.98 },
  // Tertiary text on the most elevated dark card.
  { palette: "dark", pair: ["fgSubtle", "surfaceElevated"], measured: 4.48 },
  // The PRESSED state of a primary CTA: accentFg on accentDim. Transient, but
  // it is the label of the control the finger is on.
  { palette: "dark", pair: ["accentFg", "accentDim"], measured: 3.26 },
  // Accent text on its own tint (selected rows, chips).
  { palette: "dark", pair: ["accent", "accentSubtle"], measured: 4.24 },
];

describe("text tokens clear the normal-text floor in BOTH palettes", () => {
  for (const [name, palette] of Object.entries(palettes)) {
    for (const [fg, bg] of TEXT_PAIRS) {
      it(`${name}: ${fg} on ${bg}`, () => {
        const ratio = contrastRatio(palette[fg], palette[bg]);
        expect(
          ratio,
          `${name}: ${fg}(${palette[fg]}) on ${bg}(${palette[bg]}) measured ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(NORMAL_TEXT_MIN);
      });
    }
  }
});

describe("known shortfalls stay large-text-only, and stay documented", () => {
  for (const { palette, pair, measured } of BELOW_NORMAL_TEXT) {
    const [fg, bg] = pair;
    it(`${palette}: ${fg} on ${bg} is large-text only (${measured}:1)`, () => {
      const p = palettes[palette];
      const ratio = contrastRatio(p[fg], p[bg]);
      expect(
        ratio,
        `${palette}: ${fg} on ${bg} measured ${ratio.toFixed(2)}:1 — below the large-text floor`,
      ).toBeGreaterThanOrEqual(LARGE_TEXT_MIN);
      expect(
        ratio,
        `${palette}: ${fg} on ${bg} now measures ${ratio.toFixed(2)}:1 — it clears normal text, so move it into TEXT_PAIRS and delete this entry`,
      ).toBeLessThan(NORMAL_TEXT_MIN);
      expect(ratio).toBeCloseTo(measured, 1);
    });
  }
});

/**
 * Pill tones on their OWN wash (A11Y-11).
 *
 * TEXT_PAIRS measures each tone on a SOLID ground. A Pill paints its label on
 * the tone at PILL_WASH_ALPHA composited OVER a ground, which is darker than
 * the ground in light mode and lighter in dark mode, and no pair above covered
 * it. That is how light danger shipped at 3.80:1 and dark accent at 3.55:1, on
 * 11pt uppercase text (badgeSmall) that needs the full normal-text floor.
 *
 * The tint map and the grounds are this file's own, not the resolver's: if the
 * resolver stops considering a ground, the ground still gets measured here.
 */
const PILL_TINT: Record<PillTone, TokenKey> = {
  neutral: "fgMuted",
  accent: "accent",
  success: "success",
  warning: "warning",
  danger: "danger",
  info: "info",
};
/** The page, a section band, a card, a sheet. SubscriberRow puts a selected row's pills on bgSubtle. */
const PILL_GROUNDS: TokenKey[] = ["bg", "bgSubtle", "surface", "surfaceElevated"];
const PILL_TONES = Object.keys(PILL_TINT) as PillTone[];

/** Worst ratio of `ink` against `tint`'s wash over every pill ground. */
function worstOnWash(
  palette: (typeof palettes)[keyof typeof palettes],
  ink: string,
  tint: string,
): number {
  return Math.min(
    ...PILL_GROUNDS.map((ground) =>
      contrastRatio(ink, blendOver(tint, palette[ground], PILL_WASH_ALPHA)),
    ),
  );
}

describe("pill ink clears the normal-text floor on its own tint, over every ground", () => {
  for (const [name, palette] of Object.entries(palettes)) {
    for (const tone of PILL_TONES) {
      const tint = palette[PILL_TINT[tone]];
      for (const ground of PILL_GROUNDS) {
        it(`${name}: ${tone} pill on ${ground}`, () => {
          const { ink, wash } = pillColors(palette, tone);
          // The composite below is only the one on screen if the wash Pill
          // paints IS the tone at PILL_WASH_ALPHA.
          expect(wash).toBe(withAlpha(tint, PILL_WASH_ALPHA));
          const composite = blendOver(tint, palette[ground], PILL_WASH_ALPHA);
          const ratio = contrastRatio(ink, composite);
          expect(
            ratio,
            `${name}: ${tone} ink ${ink} on ${tint}@${PILL_WASH_ALPHA} over ${ground}(${palette[ground]}) = ${composite} measured ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(NORMAL_TEXT_MIN);
        });
      }
    }
  }
});

describe("pill ink only moves where it had to", () => {
  // Pill has 233 call sites. A tone that already cleared must keep its exact
  // colour, and a palette that ships an AA-tuned ink gets that ink, not a
  // derived one.
  for (const [name, palette] of Object.entries(palettes)) {
    for (const tone of PILL_TONES) {
      const tint = palette[PILL_TINT[tone]];
      const emphasis =
        tone === "danger"
          ? palette.dangerEmphasis
          : tone === "success"
            ? palette.successEmphasis
            : null;
      const preferred = emphasis ?? tint;
      if (worstOnWash(palette, preferred, tint) < NORMAL_TEXT_MIN) continue;
      it(`${name}: ${tone} keeps ${emphasis ? "the palette's emphasis ink" : "its own tone"} (${preferred})`, () => {
        expect(pillColors(palette, tone).ink).toBe(preferred);
      });
    }
  }

  it("never flattens a pill's label into body text", () => {
    for (const [name, palette] of Object.entries(palettes)) {
      for (const tone of PILL_TONES) {
        const { ink } = pillColors(palette, tone);
        expect(
          ink.toLowerCase(),
          `${name}: ${tone} ink collapsed to fg`,
        ).not.toBe(palette.fg.toLowerCase());
      }
    }
  });
});

describe("gold is a fill, never a text colour", () => {
  it("carries INK text at normal-text contrast in both palettes", () => {
    // Brand ink (#0F0F0F) is `fg` in the light palette and `bg` in the dark
    // one; either way it is the only foreground a gold fill may carry. Dark
    // `fg` (#F6F4ED) on gold measures 1.54:1 — a gold pill with the theme's
    // normal text colour on it is unreadable in dark mode.
    const inkOnGold: [string, string, string][] = [
      ["light", light.fg, light.gold],
      ["dark", dark.bg, dark.gold],
    ];
    for (const [name, ink, gold] of inkOnGold) {
      const ratio = contrastRatio(ink, gold);
      expect(
        ratio,
        `${name}: ink on gold measured ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(NORMAL_TEXT_MIN);
    }
    expect(contrastRatio(dark.fg, dark.gold)).toBeLessThan(LARGE_TEXT_MIN);
  });

  it("is unreadable AS text on the light page, which is why it is a fill", () => {
    // 1.83:1. Nothing in app/ or src/ paints text with t.gold today; this
    // assertion is what keeps that true by accident-proofing the token's
    // meaning rather than trusting a comment.
    expect(contrastRatio(light.gold, light.bg)).toBeLessThan(LARGE_TEXT_MIN);
  });
});

describe("focus and accent read as UI components", () => {
  it("clears the non-text floor on every base surface", () => {
    for (const [name, palette] of Object.entries(palettes)) {
      for (const token of ["focus", "accent"] as const) {
        for (const surface of ["bg", "bgSubtle", "surface"] as const) {
          const ratio = contrastRatio(palette[token], palette[surface]);
          expect(
            ratio,
            `${name}: ${token} on ${surface} measured ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_MIN);
        }
      }
    }
  });
});
