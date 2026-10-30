/**
 * lib/motion.ts — the app's single motion vocabulary.
 *
 * Why this file exists: the monorepo already ships motion tokens in
 * `@postwave/design-tokens` (durations + dual-shaped easing curves, designed
 * explicitly for `react-native-reanimated` consumers — see that package's
 * motion.ts header), and `react-native-reanimated@4` is already a dependency.
 * But before this file, mobile used them in exactly five files, all of them
 * onboarding/tour chrome: BrandedSplash, OnboardingWizard, OnboardingChecklist,
 * TourOverlay, TourTooltip. Every *product* surface — 44 screens — had zero
 * animation. The brand's motion language was built and never wired in.
 *
 * This module closes that gap with three rules:
 *
 *  1. NO RAW NUMBERS. Screens never write `withTiming(v, { duration: 200 })`.
 *     They call `timing(v, "enter")` and the curve comes from the token set,
 *     so a change to the brand's motion feel lands everywhere at once.
 *
 *  2. REDUCE MOTION IS NOT OPTIONAL. Every helper here collapses to an
 *     instant, non-animated value when the OS accessibility setting is on.
 *     Animation that ignores that setting is an accessibility defect, not a
 *     polish nit — vestibular disorders make large motion genuinely painful.
 *     `useMotion()` reads the live OS setting so it also responds to a change
 *     made while the app is open.
 *
 *  3. WORKLET-SAFE. The `timing`/`spring` helpers are plain functions over
 *     reanimated primitives so they can be called from inside `useAnimatedStyle`
 *     and gesture worklets. They take the resolved `reduceMotion` boolean as an
 *     argument rather than calling a hook, because hooks cannot run on the UI
 *     thread.
 *
 * Rule 2 is ENFORCED, not merely stated: `reduceMotionCoverage.test.ts` fails
 * the build for any module that imports an animation primitive without being
 * able to see the setting. Components that legitimately bypass this file —
 * direct manipulation, or a leaf whose caller owns the decision — appear in
 * that test's named exemption list with the reason written down.
 */
import { motion } from "@postwave/design-tokens";
import { LayoutAnimation } from "react-native";
import { Easing, ReduceMotion, useReducedMotion, withSpring, withTiming, type WithTimingConfig } from "react-native-reanimated";

/**
 * Named motion intents. Screens pick the intent, never the number.
 *
 *  - `enter`   — something appearing (sheet, toast, newly-loaded row).
 *                Decelerating: fast in, gentle settle.
 *  - `exit`    — something leaving. Accelerating and shorter than `enter`,
 *                because a departing element should not hold attention.
 *  - `move`    — an element travelling to a new position (spotlight travel,
 *                reordering, a selection indicator sliding).
 *  - `emphasis`— a celebratory / confirming pop, with the token set's gentle
 *                overshoot curve.
 *  - `fill`    — progress-style fills (rings, bars, count-ups). Long and
 *                symmetric so the eye can track the value changing.
 */
export type MotionIntent = "enter" | "exit" | "move" | "emphasis" | "fill";

interface IntentSpec {
  duration: number;
  bezier: readonly [number, number, number, number];
}

const INTENTS: Record<MotionIntent, IntentSpec> = {
  enter: {
    duration: motion.durations.tooltipEnterMs,
    bezier: motion.easing.decelerate.bezier,
  },
  exit: {
    duration: motion.durations.exitMs,
    bezier: motion.easing.accelerate.bezier,
  },
  move: {
    duration: motion.durations.spotlightTravelMs,
    bezier: motion.easing.standard.bezier,
  },
  emphasis: {
    duration: motion.durations.tooltipEnterMs,
    bezier: motion.easing.spring.bezier,
  },
  fill: {
    duration: motion.durations.ringFillMs,
    bezier: motion.easing.standard.bezier,
  },
};

/** Milliseconds for an intent — for non-reanimated consumers (setTimeout, LayoutAnimation). */
export function durationFor(intent: MotionIntent, reduceMotion = false): number {
  return reduceMotion ? 0 : INTENTS[intent].duration;
}

/**
 * A `withTiming` config for the given intent.
 *
 * Note on `reduceMotion`: reanimated has its own `ReduceMotion` enum that can
 * defer the decision to the system. We pass the resolved boolean explicitly
 * instead, because callers frequently need to make *structural* choices too
 * (skip a shimmer loop entirely rather than run it at 0ms), and a single
 * source for that decision keeps the two in agreement.
 */
export function timingConfig(
  intent: MotionIntent,
  reduceMotion = false,
): WithTimingConfig {
  const spec = INTENTS[intent];
  return {
    duration: reduceMotion ? 0 : spec.duration,
    easing: Easing.bezier(...spec.bezier),
    reduceMotion: ReduceMotion.Never, // we already resolved it above
  };
}

/**
 * Animate `toValue` with the named intent. Worklet-safe.
 *
 *   const style = useAnimatedStyle(() => ({
 *     opacity: timing(visible ? 1 : 0, "enter", reduceMotion),
 *   }));
 */
export function timing(
  toValue: number,
  intent: MotionIntent = "enter",
  reduceMotion = false,
): number {
  "worklet";
  const spec = INTENTS[intent];
  return withTiming(toValue, {
    duration: reduceMotion ? 0 : spec.duration,
    easing: Easing.bezier(spec.bezier[0], spec.bezier[1], spec.bezier[2], spec.bezier[3]),
    reduceMotion: ReduceMotion.Never,
  });
}

/**
 * A physical spring for gesture-driven motion (swipe-row snap-back, sheet
 * drag release). Springs beat timing curves for anything the finger was just
 * touching, because the motion continues the user's own velocity.
 *
 * `damping`/`stiffness` are deliberately on the crisp side: an admin tool's
 * rows should settle immediately, not wobble.
 */
export function spring(toValue: number, reduceMotion = false): number {
  "worklet";
  if (reduceMotion) {
    return withTiming(toValue, { duration: 0, reduceMotion: ReduceMotion.Never });
  }
  return withSpring(toValue, {
    damping: 20,
    stiffness: 260,
    mass: 0.9,
    overshootClamping: false,
    reduceMotion: ReduceMotion.Never,
  });
}

/**
 * Animate the NEXT layout pass — for the case reanimated cannot address: a
 * change whose whole point is that it moves the elements AROUND it.
 *
 * Swapping a list's filter, revealing a banner above the navigator, or
 * expanding a row all reflow siblings. A self-contained opacity animation on
 * the thing that changed leaves everything else jumping to its new position in
 * a single frame, which is the motion people actually notice and dislike.
 *
 * CALL THIS DURING RENDER OR IN THE EVENT HANDLER, NOT IN AN EFFECT: it
 * configures the next layout pass, and by the time an effect runs the pass that
 * moved everything has already committed.
 *
 * Reduce Motion collapses it to no configuration at all — deliberately not to a
 * 0ms animation, because the point is that no animation is scheduled.
 */
export function animateNextLayout(
  intent: MotionIntent = "enter",
  reduceMotion = false,
): void {
  if (reduceMotion) return;
  LayoutAnimation.configureNext({
    duration: durationFor(intent, false),
    create: {
      type: LayoutAnimation.Types.easeInEaseOut,
      property: LayoutAnimation.Properties.opacity,
    },
    update: { type: LayoutAnimation.Types.easeInEaseOut },
    delete: {
      type: LayoutAnimation.Types.easeInEaseOut,
      property: LayoutAnimation.Properties.opacity,
    },
  });
}

export interface MotionPreferences {
  /** True when the OS "Reduce Motion" accessibility setting is enabled. */
  reduceMotion: boolean;
  /** Convenience: duration for an intent, already collapsed to 0 when reduced. */
  duration: (intent: MotionIntent) => number;
  /**
   * Convenience: `animateNextLayout` with the setting already applied, so a
   * call site cannot forget to honour it. Prefer this over the bare function.
   */
  animateLayout: (intent?: MotionIntent) => void;
}

/**
 * Read the live motion preferences. Call this in a component and thread the
 * `reduceMotion` boolean into worklets — do NOT call the hook inside one.
 */
export function useMotion(): MotionPreferences {
  const reduceMotion = useReducedMotion();
  return {
    reduceMotion,
    duration: (intent: MotionIntent) => durationFor(intent, reduceMotion),
    animateLayout: (intent: MotionIntent = "enter") =>
      animateNextLayout(intent, reduceMotion),
  };
}
