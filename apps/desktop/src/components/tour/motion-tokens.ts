/**
 * Onboarding / tour MOTION tokens — desktop-local mirror.
 *
 * MIRRORS @postwave/design-tokens motion — keep in sync.
 *
 * apps/desktop depends on @postwave/telemetry but NOT @postwave/design-tokens,
 * so (matching desktop's existing pattern of locally-defined --pw-* CSS vars)
 * we copy the canonical numbers here rather than add a package dependency. The
 * colour literals below are the resolved palette values that the canonical
 * `motion.spotlight.accent*` / `confetti.palette*` reference (light/dark ember
 * + gold). The live spotlight outline still tracks the runtime `--pw-accent`
 * CSS var for theme correctness; these constants drive the JS-side knobs
 * (spotlight geometry, confetti spray) and let us inject the canonical
 * durations/easing as CSS custom properties.
 *
 * If @postwave/design-tokens motion changes, update these to match.
 */

/** A motion easing curve, expressed for CSS consumers (cubic-bezier string). */
export interface EasingToken {
  /** `cubic-bezier(...)` — drop straight into a CSS transition / keyframe. */
  css: string;
  /** `[x1, y1, x2, y2]` — the raw coefficients. */
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
    /** Ember accent — resolved palette literals (light.accent / dark.accent). */
    accentLight: "#C8102E",
    accentDark: "#E55262",
    /** Ring stroke width (px). */
    ringWidth: 2,
    /** Ring inner blur radius (px). */
    ringBlur: 4,
    /** Outer ember glow radius (px). */
    ringGlow: 8,
    /** Breathing room between the target's bounds and the ring (px). */
    padding: 8,
    /** Corner radius of the spotlight cut-out (px) — radius.lg. */
    radius: 12,
  },

  /** The dimmed scrim behind the spotlight. */
  backdrop: {
    /** Unified scrim opacity. */
    opacity: 0.76,
    /** Backdrop blur (px). */
    blur: 2,
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

  /** Named easing curves (CSS cubic-bezier string + bezier tuple). */
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
    /** Canonical particle count. */
    count: 24,
    /** Particle palette — ember + gold + lifted ember (light.accent/gold/dark.accent). */
    paletteLight: ["#C8102E", "#F2B233", "#E55262"] as const,
    /** Particle palette — dark theme (dark.accent/gold + light.gold). */
    paletteDark: ["#E55262", "#F1C04C", "#F2B233"] as const,
    /** Radial spray spread in degrees. */
    spreadDeg: 360,
    /** Flight time of a particle (ms). */
    flightMs: 1200,
    /** Per-particle launch stagger (ms) for an organic burst. */
    staggerMs: 18,
  },
} as const;

export type MotionTokens = typeof motion;
