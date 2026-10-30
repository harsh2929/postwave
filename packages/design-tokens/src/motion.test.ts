//
// Guards the onboarding MOTION tokens against the drift they were created to
// kill: a detached spotlight color literal and per-client confetti counts.

import { describe, expect, it } from "vitest";
import { dark, light } from "./tokens";
import { motion, reducedMotion } from "./index";

describe("onboarding motion tokens", () => {
  it("spotlight accent tracks the palette ember (not a detached literal)", () => {
    expect(motion.spotlight.accentLight).toBe(light.accent);
    expect(motion.spotlight.accentDark).toBe(dark.accent);
  });

  it("confetti count is a single canonical value (was 24 / 24 / 18)", () => {
    expect(typeof motion.confetti.count).toBe("number");
    expect(motion.confetti.count).toBeGreaterThan(0);
  });

  it("confetti palette is drawn from brand spark colors", () => {
    expect(motion.confetti.paletteLight).toContain(light.accent);
    expect(motion.confetti.paletteLight).toContain(light.gold);
  });

  it("every easing token exposes both a CSS string and a bezier tuple", () => {
    for (const token of Object.values(motion.easing)) {
      expect(token.css).toMatch(/^cubic-bezier\(/);
      expect(token.bezier).toHaveLength(4);
      // The two shapes must encode the same curve.
      expect(token.css).toBe(`cubic-bezier(${token.bezier.join(", ")})`);
    }
  });

  it("backdrop opacity is in a sane scrim range", () => {
    expect(motion.backdrop.opacity).toBeGreaterThan(0.5);
    expect(motion.backdrop.opacity).toBeLessThan(1);
  });
});

describe("reducedMotion() — the shared Reduce Motion rule", () => {
  it("zeroes every duration the tokens declare, derived from the tokens themselves", () => {
    // Keys come from `motion.durations`, not a restated list, so a duration
    // added to the tokens later cannot escape the rule without failing here.
    const keys = Object.keys(motion.durations);
    expect(keys.length).toBeGreaterThanOrEqual(4);
    const out = reducedMotion(motion);
    for (const k of keys) {
      expect(out.durations[k as keyof typeof out.durations]).toBe(0);
    }
    expect(out.confetti.flightMs).toBe(0);
    expect(out.confetti.staggerMs).toBe(0);
  });

  it("leaves everything that is not a duration untouched", () => {
    const out = reducedMotion(motion);
    expect(out.easing).toBe(motion.easing);
    expect(out.spotlight).toBe(motion.spotlight);
    expect(out.backdrop).toBe(motion.backdrop);
    expect(out.confetti.count).toBe(motion.confetti.count);
    expect(out.confetti.paletteLight).toBe(motion.confetti.paletteLight);
  });

  it("does not mutate its input", () => {
    const before = JSON.stringify(motion);
    reducedMotion(motion);
    expect(JSON.stringify(motion)).toBe(before);
    expect(motion.durations.exitMs).toBeGreaterThan(0);
  });

  it("is idempotent", () => {
    expect(reducedMotion(reducedMotion(motion) as never)).toEqual(reducedMotion(motion));
  });
});
