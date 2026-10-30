/**
 * lib/color.ts — one defensive alpha helper, instead of four hand-concatenated
 * hex strings.
 *
 * Four campaign components built tinted surfaces by appending alpha bytes to a
 * theme token: `${t.accent}14`, `${t.success}14`, `${t.success}1f`,
 * `${t.success}1a`. Two problems: the concatenated form silently produces an
 * INVALID colour string the moment a theme token becomes `rgb()` or an
 * 8-digit hex, and it produced four different alpha values for what is
 * visually the same "tinted success surface".
 *
 * Pill.tsx already had a validating implementation of exactly this; this
 * module is that logic, extracted so there is one of it.
 *
 * `legibleInkOnTint` is the other half of a tinted surface: the text colour
 * that stays readable on it (A11Y-11).
 */
import { blendOver, contrastRatio, parseHex } from "./contrast";

/** The app's single tint strength for a "surface coloured by a semantic tone". */
export const TINT_ALPHA = 0.1;
/** Slightly stronger tint for a tone that must read as a callout. */
export const TINT_ALPHA_STRONG = 0.16;

/**
 * `withAlpha("#f97316", 0.1)` → `rgba(249,115,22,0.1)`.
 *
 * Anything that is not a 7-character `#rrggbb` string is returned untouched:
 * a wrong-but-visible colour is far better than an unparseable one, which RN
 * renders as transparent black.
 */
export function withAlpha(color: string, alpha: number): string {
  if (typeof color !== "string") return color;
  if (!color.startsWith("#") || color.length !== 7) return color;
  const r = Number.parseInt(color.slice(1, 3), 16);
  const g = Number.parseInt(color.slice(3, 5), 16);
  const b = Number.parseInt(color.slice(5, 7), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    return color;
  }
  const clamped = Math.max(0, Math.min(1, alpha));
  return `rgba(${r},${g},${b},${clamped})`;
}

/** How finely `legibleInkOnTint` walks an ink toward its target: 5% a step. */
const INK_STEPS = 20;

export interface LegibleInkOptions {
  /** The ink the caller would like to use, e.g. the tone itself. */
  ink: string;
  /** The colour of the translucent wash the text sits on. */
  tint: string;
  /** The wash's opacity. */
  alpha: number;
  /** Every solid colour the wash may be composited over. */
  grounds: readonly string[];
  /** Where to walk the ink: the theme's primary text colour. */
  toward: string;
  /** The contrast floor to clear, e.g. 4.5 for normal text. */
  min: number;
}

/**
 * The ink to paint text in on a translucent `tint` wash, legible whatever the
 * wash sits on.
 *
 * Text on a tint is measured against the COMPOSITE (the tint at `alpha` over
 * the ground under it), not against the ground. The composite is darker than
 * the ground in a light theme and lighter in a dark one, so a tone that clears
 * on solid paper can fail on its own wash. This keeps `ink` when it clears
 * `min` over every ground. Otherwise it walks the ink toward `toward` in 5%
 * steps and returns the first step that clears. The label keeps its hue and
 * moves only as far as the floor needs.
 *
 * Returns `ink` untouched when any colour is not `#rrggbb` (the same
 * wrong-but-visible rule as withAlpha). If no step clears, it returns the step
 * with the best worst-case ratio, so the answer is never harder to read than
 * the ink it was given.
 */
export function legibleInkOnTint({
  ink,
  tint,
  alpha,
  grounds,
  toward,
  min,
}: LegibleInkOptions): string {
  const colours = [ink, tint, toward, ...grounds];
  if (grounds.length === 0 || colours.some((c) => parseHex(c) === null)) {
    return ink;
  }
  const washes = grounds.map((ground) => blendOver(tint, ground, alpha));
  const worst = (candidate: string): number =>
    Math.min(...washes.map((wash) => contrastRatio(candidate, wash)));
  let best = ink;
  let bestRatio = worst(ink);
  for (let step = 1; step <= INK_STEPS && bestRatio < min; step += 1) {
    const candidate = blendOver(toward, ink, step / INK_STEPS);
    const ratio = worst(candidate);
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
  }
  return best;
}
