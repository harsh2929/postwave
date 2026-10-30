/**
 * lib/pillTone.ts — what a Pill paints, per theme and tone: the wash behind the
 * label and the ink the label is drawn in.
 *
 * Pill used to draw the label in the same tone it tints the wash with. On that
 * wash the tone is not AA-safe: light danger measured 3.80:1 on a card and
 * dark accent 3.55:1 on a sheet, for 11pt uppercase text that needs 4.5:1
 * (A11Y-11). The wash is unchanged. The label now uses the palette's own
 * AA-tuned ink where the design tokens ship one (`dangerEmphasis`,
 * `successEmphasis`). Where a tone still misses the floor on some ground,
 * `legibleInkOnTint` walks it toward `fg` until it clears. Tones that already
 * cleared keep their exact colour.
 *
 * Pure (no React, no react-native) so `themeContrast.test.ts` can measure
 * every tone in both shipped palettes in the node test environment.
 */
import { legibleInkOnTint, withAlpha } from "./color";
import type { ThemeTokens } from "./theme";

export type PillTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info";

/** The wash strength: the tone at 15% reads as a tint, not a solid block. */
export const PILL_WASH_ALPHA = 0.15;

/**
 * WCAG 2.2 SC 1.4.3 normal-text floor. A pill label is badge / badgeSmall
 * (12 / 11pt semibold), well under the large-text threshold, so 3:1 is not
 * enough.
 */
const PILL_INK_CONTRAST_MIN = 4.5;

/**
 * What a pill is placed on: the page, a section band, a card, a sheet. A
 * selected SubscriberRow puts its pills on bgSubtle. Not exported on purpose:
 * the tests measure their own list, so dropping a ground here fails them.
 */
const PILL_GROUNDS = [
  "bg",
  "bgSubtle",
  "surface",
  "surfaceElevated",
] as const satisfies readonly (keyof ThemeTokens)[];

/** The token each tone tints its wash with. */
const TONE_TINT: Record<PillTone, keyof ThemeTokens> = {
  neutral: "fgMuted",
  accent: "accent",
  success: "success",
  warning: "warning",
  danger: "danger",
  info: "info",
};

/** The palette's AA-tuned ink for a tone, where the design tokens ship one. */
const TONE_INK: Partial<Record<PillTone, keyof ThemeTokens>> = {
  danger: "dangerEmphasis",
  success: "successEmphasis",
};

export interface PillColors {
  /** The tone colour the wash is made from. */
  tint: string;
  /** Pill's backgroundColor: `tint` at PILL_WASH_ALPHA. */
  wash: string;
  /** Pill's label colour, legible on `wash` over every PILL_GROUNDS entry. */
  ink: string;
}

/**
 * Resolved once per palette and tone. There are hundreds of pills in a long
 * list, and neither the palette objects nor the arithmetic change between
 * renders.
 */
const resolved = new WeakMap<object, Map<string, PillColors>>();

function resolvePillColors(t: ThemeTokens, tone: PillTone): PillColors {
  // An unknown tone (a server status cast to PillTone) reads as neutral, as it
  // always has.
  const tint = t[TONE_TINT[tone] ?? "fgMuted"];
  const inkKey = TONE_INK[tone];
  const preferred =
    inkKey && typeof t[inkKey] === "string" ? t[inkKey] : tint;
  const ink = legibleInkOnTint({
    ink: preferred,
    tint,
    alpha: PILL_WASH_ALPHA,
    grounds: PILL_GROUNDS.map((ground) => t[ground]),
    toward: t.fg,
    min: PILL_INK_CONTRAST_MIN,
  });
  return { tint, wash: withAlpha(tint, PILL_WASH_ALPHA), ink };
}

export function pillColors(t: ThemeTokens, tone: PillTone): PillColors {
  let byTone = resolved.get(t);
  if (!byTone) {
    byTone = new Map();
    resolved.set(t, byTone);
  }
  let colors = byTone.get(tone);
  if (!colors) {
    colors = resolvePillColors(t, tone);
    byTone.set(tone, colors);
  }
  return colors;
}
