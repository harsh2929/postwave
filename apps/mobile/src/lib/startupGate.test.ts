import { describe, expect, it } from "vitest";

import {
  STARTUP_WATCHDOG_MS,
  startupDegradationNotice,
  startupGateState,
  startupOutcome,
} from "./startupGate";

/**
 * SHELL#62. The bug this pins is a HANG, not a crash: with
 * `SplashScreen.preventAutoHideAsync()` at module load and
 * `if (!ready) return null`, an auth hydration that never settles leaves the
 * user on the splash forever. So the assertions that matter are the ones about
 * the unresolved states.
 */
describe("startupGateState", () => {
  it("paints immediately once auth and fonts have both settled", () => {
    expect(
      startupGateState({
        hydrated: true,
        fontsSettled: true,
        watchdogElapsed: false,
      }),
    ).toEqual({ proceed: true, degraded: null });
  });

  it("holds the splash while hydration is still in flight", () => {
    expect(
      startupGateState({
        hydrated: false,
        fontsSettled: true,
        watchdogElapsed: false,
      }),
    ).toEqual({ proceed: false, degraded: null });
  });

  it("holds the splash while fonts are still in flight", () => {
    expect(
      startupGateState({
        hydrated: true,
        fontsSettled: false,
        watchdogElapsed: false,
      }),
    ).toEqual({ proceed: false, degraded: null });
  });

  it("proceeds in an AUTH-degraded state when hydration never settles", () => {
    expect(
      startupGateState({
        hydrated: false,
        fontsSettled: true,
        watchdogElapsed: true,
      }),
    ).toEqual({ proceed: true, degraded: "auth" });
  });

  it("reports auth degradation even when fonts are ALSO unresolved", () => {
    // Which screen the user gets is decided by auth, not by a typeface.
    expect(
      startupGateState({
        hydrated: false,
        fontsSettled: false,
        watchdogElapsed: true,
      }),
    ).toEqual({ proceed: true, degraded: "auth" });
  });

  it("proceeds in a FONT-degraded state when only fonts hang", () => {
    expect(
      startupGateState({
        hydrated: true,
        fontsSettled: false,
        watchdogElapsed: true,
      }),
    ).toEqual({ proceed: true, degraded: "fonts" });
  });

  it("clears the degradation if the slow concern lands after the watchdog", () => {
    // Derived, not latched: a late hydration must not leave a permanent
    // "couldn't read your sign-in" bar over a perfectly good session.
    expect(
      startupGateState({
        hydrated: true,
        fontsSettled: true,
        watchdogElapsed: true,
      }),
    ).toEqual({ proceed: true, degraded: null });
  });

  it("keeps the watchdog bounded and non-zero", () => {
    expect(STARTUP_WATCHDOG_MS).toBeGreaterThan(1000);
    expect(STARTUP_WATCHDOG_MS).toBeLessThanOrEqual(15000);
  });
});

describe("startupDegradationNotice", () => {
  it("rules out data loss on the auth path", () => {
    const notice = startupDegradationNotice("auth");
    expect(notice.title).toMatch(/sign-in/i);
    expect(notice.message).toMatch(/nothing was deleted/i);
  });

  it("explains the font fallback as cosmetic", () => {
    const notice = startupDegradationNotice("fonts");
    expect(notice.message).toMatch(/everything works/i);
  });
});

describe("startupOutcome", () => {
  it("distinguishes a clean launch from each degraded one", () => {
    expect(startupOutcome(null)).toBe("success");
    expect(startupOutcome("auth")).toBe("degraded_auth");
    expect(startupOutcome("fonts")).toBe("degraded_fonts");
  });
});
