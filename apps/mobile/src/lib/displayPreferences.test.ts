import { describe, expect, it } from "vitest";

import {
  DEFAULT_LANDING_ROUTE,
  DEFAULT_ROW_DENSITY,
  MIN_TOUCH_TARGET,
  ROW_DENSITIES,
  densityMetrics,
  landingOptions,
  resolveLandingRoute,
  resolveRowDensity,
} from "./displayPreferences";

describe("landing route", () => {
  it("offers Approvals only to someone the handler will admit", () => {
    // GET /api/v1/approvals runs requireAdmin (approvals/handlers.go:226 →
    // :597: owner|admin, 403 otherwise). Offering it to an editor would mean
    // launching into a permission notice every time they open the app.
    expect(landingOptions(false)).not.toContain("/(tabs)/approvals");
    expect(landingOptions(true)).toContain("/(tabs)/approvals");
  });

  it("lists the choices in tab-bar order", () => {
    // The user checks whether it worked by looking at the tab bar, so the
    // control has to read left-to-right the same way the bar does.
    expect(landingOptions(true)).toEqual([
      "/(tabs)/dashboard",
      "/(tabs)/subscribers",
      "/(tabs)/campaigns",
      "/(tabs)/approvals",
    ]);
  });

  it("carries no labels at all — those are messages, not policy", () => {
    // A label here would be a second, untranslated copy of the tab-bar word.
    for (const route of landingOptions(true)) {
      expect(typeof route).toBe("string");
      expect(route.startsWith("/(tabs)/")).toBe(true);
    }
  });

  it("falls back to Home when a demotion invalidates the stored choice", () => {
    // The preference is re-resolved on every launch precisely for this: an
    // admin picks Approvals, is demoted, and must not open the app on a 403.
    expect(resolveLandingRoute("/(tabs)/approvals", true)).toBe(
      "/(tabs)/approvals",
    );
    expect(resolveLandingRoute("/(tabs)/approvals", false)).toBe(
      DEFAULT_LANDING_ROUTE,
    );
  });

  it("drops a route an older build wrote that no longer exists", () => {
    expect(resolveLandingRoute("/(tabs)/flows", true)).toBe(
      DEFAULT_LANDING_ROUTE,
    );
    expect(resolveLandingRoute("", true)).toBe(DEFAULT_LANDING_ROUTE);
    expect(resolveLandingRoute(null, true)).toBe(DEFAULT_LANDING_ROUTE);
    expect(resolveLandingRoute(undefined, true)).toBe(DEFAULT_LANDING_ROUTE);
  });

  it("refuses anything that is not one of the four fixed tabs", () => {
    // A stored value reaches router.replace(); an unvalidated one would be an
    // arbitrary navigation target written by whatever last held the key.
    expect(resolveLandingRoute("https://evil.example", true)).toBe(
      DEFAULT_LANDING_ROUTE,
    );
    expect(resolveLandingRoute("/(tabs)/subscribers/1", true)).toBe(
      DEFAULT_LANDING_ROUTE,
    );
    expect(resolveLandingRoute("__proto__", true)).toBe(DEFAULT_LANDING_ROUTE);
  });
});

describe("row density", () => {
  it("coerces an unknown stored value rather than rendering with it", () => {
    expect(resolveRowDensity("compact")).toBe("compact");
    expect(resolveRowDensity("cozy")).toBe(DEFAULT_ROW_DENSITY);
    expect(resolveRowDensity(null)).toBe(DEFAULT_ROW_DENSITY);
  });

  it("never puts a row under the touch-target floor", () => {
    // Density removes padding; it must not make a row unhittable.
    for (const density of ROW_DENSITIES) {
      expect(densityMetrics(density).rowMinHeight).toBeGreaterThanOrEqual(
        MIN_TOUCH_TARGET,
      );
    }
  });

  it("makes compact genuinely denser in every measurement", () => {
    // A preference that changes one number by two points is a placebo.
    const roomy = densityMetrics("comfortable");
    const tight = densityMetrics("compact");
    expect(tight.rowPadding).toBeLessThan(roomy.rowPadding);
    expect(tight.rowSpacing).toBeLessThan(roomy.rowSpacing);
    expect(tight.rowMinHeight).toBeLessThan(roomy.rowMinHeight);
    expect(tight.rowGap).toBeLessThanOrEqual(roomy.rowGap);
  });

  it("exposes no text-size lever at all", () => {
    // Type size belongs to the OS Dynamic Type setting (lib/typeScale.ts). A
    // density control that shrank text would override an accessibility
    // preference under the guise of a display one.
    const keys = Object.keys(densityMetrics("compact"));
    expect(keys.some((k) => /font|text|size|scale/iu.test(k))).toBe(false);
  });
});
