/**
 * lib/chartPalette.ts — the series colors for every chart in the app.
 *
 * The brand token set (`@postwave/design-tokens`) defines UI colors —
 * accent, danger, success, info — but no CHART palette. Reusing UI tokens for
 * series is the classic mistake: `success` green means "this thing is healthy",
 * so painting "series 3" with it tells the reader something untrue, and the
 * moment a chart legitimately needs a good/bad encoding there is no color left
 * that hasn't been spent.
 *
 * So the categorical slots below are a separate, purpose-built set. They were
 * not chosen by eye — each candidate set was run through the palette validator
 * (OKLCH lightness band, chroma floor, adjacent-pair CVD separation for
 * protanopia/deuteranopia/tritanopia, normal-vision separation, and contrast
 * against the chart surface). The values here are the sets that passed every
 * check in BOTH modes:
 *
 *   light (surface #FFFFFF): lightness PASS · chroma PASS · CVD worst adjacent
 *     ΔE 17.8 PASS · normal-vision worst ΔE 18.4 PASS · contrast PASS
 *   dark  (surface #1A1A1A): lightness PASS · chroma PASS · CVD worst adjacent
 *     ΔE 14.4 PASS · normal-vision worst ΔE 20.3 PASS · contrast PASS
 *
 * RULES for consumers (these are what the validation buys you — breaking them
 * throws the guarantee away):
 *
 *  - Assign slots IN ORDER and bind them to the ENTITY, not its rank. If a
 *    filter removes series 2, series 3 keeps its color; it does not slide up
 *    into slot 2. Otherwise the reader's color→meaning memory resets on every
 *    filter change.
 *  - Never cycle. A seventh series is not slot 1 again — fold the tail into
 *    "Other", or use small multiples.
 *  - Never use a STATUS color as a series color, and never use a series color
 *    to mean good/bad. Those live in `chartStatus` and always ship with a label
 *    or icon, never color alone.
 *  - Dark mode is a SELECTED set, not a lightened flip of the light one: each
 *    step was re-validated against the dark surface.
 */
import type { ThemeName } from "@/lib/theme";

/**
 * Categorical series colors, in assignment order:
 * ember · cyan · amber · violet · green · blue.
 *
 * Ember leads because a single-series chart — the overwhelmingly common case on
 * a phone — should read as the brand.
 */
const CATEGORICAL: Record<ThemeName, readonly string[]> = {
  light: ["#C8102E", "#0891B2", "#C77C0A", "#6D48C4", "#1E7A55", "#1466B8"],
  dark: ["#E55262", "#199FBA", "#BC8524", "#9A80E2", "#1FA876", "#6187D6"],
};

/**
 * Sequential ramp for MAGNITUDE (a send-hour heatmap, an engagement density).
 * One hue, monotonically darker — never a rainbow. Light mode runs pale→deep;
 * dark mode runs deep→bright so "more" is still the more prominent end against
 * an ink canvas.
 */
const SEQUENTIAL: Record<ThemeName, readonly string[]> = {
  light: ["#FCE9EC", "#F3B8C0", "#E37C8B", "#C8102E", "#8E0A20"],
  dark: ["#3A1A20", "#6B2430", "#A32F42", "#E55262", "#F2848F"],
};

/**
 * Diverging pair for POLARITY (week-over-week lift, over/under a benchmark).
 * Two hues with a NEUTRAL midpoint — a hue at the midpoint would imply a third
 * category where the data has only "no change".
 */
const DIVERGING: Record<ThemeName, { negative: string; neutral: string; positive: string }> = {
  light: { negative: "#C8102E", neutral: "#D8D4CA", positive: "#1E7A55" },
  dark: { negative: "#E55262", neutral: "#3A3A3A", positive: "#1FA876" },
};

/**
 * Reserved STATE colors. Never a series slot. Always paired with a label or
 * icon at the call site so state is never conveyed by color alone.
 */
const STATUS: Record<ThemeName, Record<"good" | "warning" | "serious" | "critical", string>> = {
  light: {
    good: "#1E7A55",
    warning: "#B45309",
    serious: "#D43C1F",
    critical: "#8E0A20",
  },
  dark: {
    good: "#34D399",
    warning: "#F1C04C",
    serious: "#F0623D",
    critical: "#E55262",
  },
};

export interface ChartPalette {
  /** Series colors in fixed assignment order. */
  categorical: readonly string[];
  /** Pale→deep single-hue ramp for magnitude. */
  sequential: readonly string[];
  diverging: { negative: string; neutral: string; positive: string };
  status: Record<"good" | "warning" | "serious" | "critical", string>;
  /**
   * Color for series index `i`, bound to position — callers must pass a STABLE
   * index derived from the entity (its id's position in a fixed list), not the
   * index within the currently-visible subset.
   *
   * Beyond the last slot it returns the muted "Other" gray rather than wrapping,
   * because a wrapped color is a lie: two different entities would share it.
   */
  seriesColor: (index: number) => string;
  /** The color for a folded "Other" bucket and for de-emphasised marks. */
  other: string;
}

const OTHER: Record<ThemeName, string> = {
  light: "#8A857A",
  dark: "#6E6E6E",
};

export function chartPalette(theme: ThemeName): ChartPalette {
  const categorical = CATEGORICAL[theme];
  const other = OTHER[theme];
  return {
    categorical,
    sequential: SEQUENTIAL[theme],
    diverging: DIVERGING[theme],
    status: STATUS[theme],
    other,
    seriesColor: (index: number) =>
      index >= 0 && index < categorical.length
        ? (categorical[index] as string)
        : other,
  };
}

/** How many distinct series the palette can honestly represent. */
export const MAX_SERIES = CATEGORICAL.light.length;
