import { describe, expect, it } from "vitest";

import {
  cooldownClock,
  cooldownRemaining,
  DEFAULT_RESEND_COOLDOWN_SECONDS,
  isCoolingDown,
  NO_COOLDOWN,
  resendLabel,
  startCooldown,
} from "./cooldown";

const NOW = 1_800_000_000_000;

describe("startCooldown", () => {
  it("stores an absolute deadline so a backgrounded app cannot stall it", () => {
    expect(startCooldown(30, NOW)).toEqual({ readyAt: NOW + 30_000 });
  });

  it("defaults to the self-imposed resend gap", () => {
    expect(startCooldown(undefined, NOW).readyAt).toBe(
      NOW + DEFAULT_RESEND_COOLDOWN_SECONDS * 1000,
    );
  });

  it("refuses to arm on a zero, negative or NaN duration", () => {
    expect(startCooldown(0, NOW)).toEqual(NO_COOLDOWN);
    expect(startCooldown(-5, NOW)).toEqual(NO_COOLDOWN);
    expect(startCooldown(Number.NaN, NOW)).toEqual(NO_COOLDOWN);
  });
});

describe("cooldownRemaining", () => {
  it("counts down against the wall clock", () => {
    const state = startCooldown(30, NOW);
    expect(cooldownRemaining(state, NOW)).toBe(30);
    expect(cooldownRemaining(state, NOW + 10_000)).toBe(20);
  });

  it("clamps to zero once elapsed, including a long suspend", () => {
    const state = startCooldown(30, NOW);
    expect(cooldownRemaining(state, NOW + 30_000)).toBe(0);
    expect(cooldownRemaining(state, NOW + 86_400_000)).toBe(0);
    expect(isCoolingDown(state, NOW + 86_400_000)).toBe(false);
  });

  it("reports no cooldown for the idle state", () => {
    expect(cooldownRemaining(NO_COOLDOWN, NOW)).toBe(0);
    expect(isCoolingDown(NO_COOLDOWN, NOW)).toBe(false);
  });
});

describe("cooldownClock", () => {
  it.each([
    [0, "0:00"],
    [-1, "0:00"],
    [5, "0:05"],
    [24, "0:24"],
    [60, "1:00"],
    [125, "2:05"],
  ])("renders %s seconds as %s", (input, expected) => {
    expect(cooldownClock(input)).toBe(expected);
  });
});

describe("resendLabel", () => {
  it("swaps between the countdown and the idle label", () => {
    expect(resendLabel("Resend link", 24)).toBe("Resend in 0:24");
    expect(resendLabel("Resend link", 0)).toBe("Resend link");
  });
});
