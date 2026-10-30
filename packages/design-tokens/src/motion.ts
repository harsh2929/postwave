/**
 * Onboarding / walkthrough MOTION tokens — the single source of truth for the
 * spotlight, backdrop, tooltip, and confetti feel across every client's tour
 * and celebration surfaces.
 *
 * Before this module each client hand-tuned its own values and they drifted:
 * the spotlight color was a hardcoded `#C8102E` literal (correct ember, but
 * detached from the palette so it never tracked dark mode), backdrop opacity
 * ranged 0.72–0.78, and confetti particle counts diverged 24 / 24 / 18 across
 * web / desktop / mobile. These values reconcile that.
 *
 * Each platform maps these to its own engine:
 *  - web      → imports this module and writes the values onto CSS custom
 *               properties at runtime (components/tour/TourOverlay.tsx)
 *  - mobile   → imports this module for `react-native-reanimated` (use
 *               `easing.*.bezier` with `Easing.bezier(...)`, durations as
 *               `withTiming` configs)
 *  - desktop  → does NOT import this module. Its tour is plain CSS keyframes
 *               with no token injection on that path, so the numbers are
 *               written literally in styles/collaboration-tour.css and held to
 *               these values by drift.test.ts instead of by the type system.
 *
 * That distinction is worth stating because the reconciliation above was only
 * ever half-true: desktop kept 78% / 3px — the top of the very "0.72–0.78"
 * spread this module claims to have closed — until the drift guard was
 * extended to cover motion. Its durations (320 / 240 / 1600 / 1200ms) and
 * confetti count (24) did match, but by coincidence of hand-tuning rather than
 * by sharing a source, which is exactly the state that drifts again.
 *
 * Desktop's EASING is still its own: the spotlight uses
 * `cubic-bezier(0.16, 1, 0.3, 1)` and the tooltip `ease-out`, neither of which
 * is one of the four curves below. Changing them alters the feel, so it is a
 * design decision rather than a drift fix, and is left alone deliberately.
 *
 * Easing is exported in BOTH shapes — a `cubic-bezier(...)` string for CSS and
 * a coefficient tuple for `Easing.bezier(x1,y1,x2,y2)` — so the curve is
 * defined once and consumed natively everywhere.
 */

import { dark, light } from "./tokens.js";
import { radius } from "./tokens.js";

/** A motion easing curve, expressed for both CSS and reanimated consumers. */
export interface EasingToken {
  /** `cubic-bezier(...)` — drop straight into a CSS `transition` / keyframe. */
  css: string;
  /** `[x1, y1, x2, y2]` — pass to reanimated's `Easing.bezier(...)`. */
  bezier: readonly [number, number, number, number];
}

const bezier = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): EasingToken => ({
  css: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`,
  bezier: [x1, y1, x2, y2],
});

export const motion = {
  /** The spotlight ring that cuts out the highlighted target. */
  spotlight: {
    /** Ember accent — light/dark variants, sourced from the palette (NOT a literal). */
    accentLight: light.accent,
    accentDark: dark.accent,
    /** Ring stroke width (px). */
    ringWidth: 2,
    /** Ring inner blur radius (px). */
    ringBlur: 4,
    /** Outer ember glow radius (px). */
    ringGlow: 8,
    /** Breathing room between the target's bounds and the ring (px). */
    padding: 8,
    /** Corner radius of the spotlight cut-out (px). */
    radius: radius.lg,
  },

  /** The dimmed scrim behind the spotlight. */
  backdrop: {
    /** Unified scrim opacity (was 0.72–0.78 across clients). */
    opacity: 0.76,
    /** Backdrop blur (px). */
    blur: 2,
    /** Frosted web-tour material, applied only outside the highlighted area. */
    frosted: {
      colorLight: light.bg,
      colorDark: dark.surface,
      opacity: 0.58,
      blur: 14,
      saturation: 1.35,
    },
  },

  /** Animation durations (ms). */
  durations: {
    /** Spotlight travel between steps. */
    spotlightTravelMs: 320,
    /** Tooltip entrance (scale + fade). */
    tooltipEnterMs: 240,
    /** Attention pulse loop period on non-center steps. */
    pulseMs: 1600,
    /** Generic exit / fade-out. */
    exitMs: 200,
    /** Progress-ring / checkmark fill animation. */
    ringFillMs: 600,
  },

  /** Named easing curves, dual-shaped (CSS string + bezier tuple). */
  easing: {
    /** Symmetric ease-in-out — default for most transitions. */
    standard: bezier(0.4, 0, 0.2, 1),
    /** Decelerate — entrances (start fast, settle gently). */
    decelerate: bezier(0, 0, 0.2, 1),
    /** Accelerate — exits. */
    accelerate: bezier(0.4, 0, 1, 1),
    /** Gentle overshoot — celebratory / spring-ish pops. */
    spring: bezier(0.34, 1.56, 0.64, 1),
  },

  /** Confetti celebration parameters. */
  confetti: {
    /** SINGLE canonical particle count (reconciles 24 / 24 / 18). */
    count: 24,
    /** Particle palette — ember + gold + lifted ember, the brand spark set. */
    paletteLight: [light.accent, light.gold, dark.accent] as const,
    paletteDark: [dark.accent, dark.gold, light.gold] as const,
    /** Radial spray spread in degrees. */
    spreadDeg: 360,
    /** Flight time of a particle (ms). */
    flightMs: 1200,
    /** Per-particle launch stagger (ms) for an organic burst. */
    staggerMs: 18,
  },
} as const;

export type MotionTokens = typeof motion;

/** MotionTokens with every duration widened to `number`, because under Reduce
 *  Motion they are all 0 and the literal types above would lie. */
export type ReducedMotionTokens = Omit<MotionTokens, "durations" | "confetti"> & {
  durations: { [K in keyof MotionTokens["durations"]]: number };
  confetti: Omit<MotionTokens["confetti"], "flightMs" | "staggerMs"> & {
    flightMs: number;
    staggerMs: number;
  };
};

/**
 * The Reduce Motion rule, in one place: every duration and stagger becomes 0;
 * easing, geometry, opacity and colour are untouched.
 *
 * A user who asked the OS to stop motion still gets the FINAL state of every
 * transition -- the spotlight lands, the tooltip appears, the ring is full --
 * they just do not get the travel. Zeroing durations rather than skipping
 * animations keeps every completion callback firing, so nothing that waits on
 * an animation ending is left waiting forever.
 *
 * Before this existed the rule lived in each surface separately: mobile's
 * lib/motion.ts as `reduceMotion ? 0 : spec.duration`, TourOverlay's own
 * ternary, desktop consumers branching per component. Same rule, N copies --
 * the ecosystem blueprint's dim-3 "no shared reduced-motion abstraction". Each
 * surface still decides HOW it learns the preference (matchMedia on the desk,
 * reanimated's useReducedMotion on the phone); what it does with the answer is
 * now shared.
 */
export function reducedMotion(tokens: MotionTokens = motion): ReducedMotionTokens {
  const durations = Object.fromEntries(
    Object.keys(tokens.durations).map((k) => [k, 0]),
  ) as ReducedMotionTokens["durations"];
  return {
    ...tokens,
    durations,
    confetti: { ...tokens.confetti, flightMs: 0, staggerMs: 0 },
  };
}
