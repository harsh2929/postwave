/**
 * Demo mode must be unreachable in production.
 *
 * It swaps the platform keychain for an in-memory map. On a real build that
 * would mean an app which forgets a signed-in session, a revocation marker and
 * a cleanup latch the moment it is killed — so "is this production?" has to be
 * answerable here rather than by reading a call site and trusting it.
 */
import { describe, expect, it } from "vitest";

import { demoModeEnabled } from "./demoMode";

describe("demoModeEnabled", () => {
  it("refuses production outright, whatever the flag says", () => {
    for (const profile of ["production", "Production", " PRODUCTION "]) {
      expect(demoModeEnabled({ EXPO_PUBLIC_DEV_DEMO: "1" }, profile)).toBe(false);
    }
  });

  it("requires the flag to be exactly \"1\"", () => {
    for (const flag of [undefined, "", "0", "true", "yes", "11", "1 x"]) {
      expect(demoModeEnabled({ EXPO_PUBLIC_DEV_DEMO: flag }, "development")).toBe(
        false,
      );
    }
  });

  it("enables only on a non-production build with the exact flag", () => {
    expect(demoModeEnabled({ EXPO_PUBLIC_DEV_DEMO: "1" }, "development")).toBe(true);
    // preview is what testers receive; a flag must not flip it into demo data.
    expect(demoModeEnabled({ EXPO_PUBLIC_DEV_DEMO: " 1 " }, "preview")).toBe(false);
  });

  it("reads the profile it is HANDED, never an ambient one", () => {
    // The bug isSdkLocalHttpHost shipped with: consulting a module constant
    // instead of the argument, so the caller's profile was silently ignored.
    // An unset profile is not a licence: fail closed, not open.
    expect(demoModeEnabled({ EXPO_PUBLIC_DEV_DEMO: "1" }, undefined)).toBe(false);
    expect(demoModeEnabled({ EXPO_PUBLIC_DEV_DEMO: "1" }, "development")).toBe(true);
    expect(demoModeEnabled({ EXPO_PUBLIC_DEV_DEMO: "1" }, "production")).toBe(false);
  });
});
