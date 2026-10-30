import { describe, expect, it } from "vitest";

import {
  APP_LOCK_GRACE_CHOICES,
  DEFAULT_APP_LOCK_GRACE_SECONDS,
  graceAccessibilityLabel,
  graceLabel,
  normalizeGraceSeconds,
  shouldRepromptOnForeground,
} from "./appLockGrace";

describe("normalizeGraceSeconds", () => {
  it("defaults to prompting every time, preserving the armed lock's behaviour", () => {
    expect(DEFAULT_APP_LOCK_GRACE_SECONDS).toBe(0);
    for (const bad of [undefined, null, "", "abc", NaN, -1, {}, []]) {
      expect(normalizeGraceSeconds(bad)).toBe(0);
    }
  });

  it("accepts the offered choices, from storage's string form too", () => {
    for (const choice of APP_LOCK_GRACE_CHOICES) {
      expect(normalizeGraceSeconds(choice)).toBe(choice);
      expect(normalizeGraceSeconds(String(choice))).toBe(choice);
    }
  });

  it("snaps an unknown value DOWN, never up — a corrupt value must not buy exposure", () => {
    expect(normalizeGraceSeconds(59)).toBe(0);
    expect(normalizeGraceSeconds(299)).toBe(60);
    expect(normalizeGraceSeconds(899)).toBe(300);
    expect(normalizeGraceSeconds(86_400)).toBe(900);
  });
});

describe("shouldRepromptOnForeground", () => {
  it("always re-prompts at zero grace, however brief the switch", () => {
    expect(shouldRepromptOnForeground(1_000, 1_001, 0)).toBe(true);
  });

  it("skips the prompt inside the window — the authenticator round-trip", () => {
    // Away for two seconds with a one-minute grace.
    expect(shouldRepromptOnForeground(10_000, 12_000, 60)).toBe(false);
  });

  it("re-prompts once the window elapses", () => {
    expect(shouldRepromptOnForeground(10_000, 10_000 + 60_001, 60)).toBe(true);
  });

  it("re-prompts on a fresh arm, which has no background timestamp", () => {
    expect(shouldRepromptOnForeground(null, 1_000, 900)).toBe(true);
  });

  it("fails closed when the clock moved backwards", () => {
    // Device time changed while backgrounded: elapsed looks negative.
    expect(shouldRepromptOnForeground(50_000, 10_000, 900)).toBe(true);
  });

  it("cannot be held open past the maximum by a hostile stored value", () => {
    // A stored 24h would normalise to 15m; an hour away must still re-prompt.
    expect(shouldRepromptOnForeground(0, 3_600_000, 86_400)).toBe(true);
  });
});

describe("labels", () => {
  it("names every choice distinctly, visibly and to a screen reader", () => {
    const visible = APP_LOCK_GRACE_CHOICES.map(graceLabel);
    const spoken = APP_LOCK_GRACE_CHOICES.map(graceAccessibilityLabel);
    expect(new Set(visible).size).toBe(APP_LOCK_GRACE_CHOICES.length);
    expect(new Set(spoken).size).toBe(APP_LOCK_GRACE_CHOICES.length);
    expect(graceLabel(0)).toBe("Immediately");
    expect(graceAccessibilityLabel(60)).toContain("1 minute");
    expect(graceAccessibilityLabel(900)).toContain("15 minutes");
  });
});
