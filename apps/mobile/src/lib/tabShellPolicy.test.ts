import { describe, expect, it } from "vitest";

import { MOBILE_SECONDARY_ROUTES } from "@/lib/mobileRouteManifest";
import { deniedSecondaryRoute } from "@/lib/tabShellPolicy";

/**
 * The shell's role gate. These cases exist because the gate's CONSEQUENCE used
 * to be "unmount the whole tab navigator", so its inputs were never exercised
 * anywhere a test could see them.
 */
describe("deniedSecondaryRoute", () => {
  const adminOnly = MOBILE_SECONDARY_ROUTES.filter(
    (route) => route.minimumRole === "admin",
  );

  it("has admin-gated routes to reason about", () => {
    expect(adminOnly.length).toBeGreaterThan(0);
    expect(adminOnly.map((route) => route.key)).toContain("migrations");
  });

  it("denies an admin-only route to a viewer, naming the route", () => {
    const denied = deniedSecondaryRoute(
      "/(tabs)/migrations",
      "viewer",
      "session",
    );
    expect(denied?.key).toBe("migrations");
    expect(denied?.label).toBe("Migrations");
  });

  it("denies nested paths under an admin-only route", () => {
    expect(
      deniedSecondaryRoute("/(tabs)/migrations/run-123", "editor", "session")
        ?.key,
    ).toBe("migrations");
  });

  it("allows an admin-only route to admin and owner", () => {
    for (const role of ["admin", "owner", " Owner "]) {
      expect(deniedSecondaryRoute("/(tabs)/migrations", role, "session")).toBe(
        null,
      );
    }
  });

  it("never denies a primary tab, at any role", () => {
    for (const path of [
      "/(tabs)/dashboard",
      "/(tabs)/subscribers",
      "/(tabs)/campaigns",
      "/(tabs)/approvals",
      "/(tabs)/more",
    ]) {
      expect(deniedSecondaryRoute(path, "viewer", "session")).toBe(null);
      expect(deniedSecondaryRoute(path, null, null)).toBe(null);
    }
  });

  it("denies every gated route to an API-key session, which carries no role", () => {
    for (const route of adminOnly) {
      expect(deniedSecondaryRoute(route.route, "owner", "api_key")?.key).toBe(
        route.key,
      );
    }
  });

  it("leaves ungated secondary routes open to an API-key session", () => {
    const ungated = MOBILE_SECONDARY_ROUTES.filter(
      (route) => !route.minimumRole,
    );
    expect(ungated.length).toBeGreaterThan(0);
    for (const route of ungated) {
      expect(deniedSecondaryRoute(route.route, null, "api_key")).toBe(null);
    }
  });

  it("denies a gated route when the role is unknown or missing", () => {
    expect(
      deniedSecondaryRoute("/(tabs)/migrations", null, "session")?.key,
    ).toBe("migrations");
    expect(
      deniedSecondaryRoute("/(tabs)/migrations", "wizard", "session")?.key,
    ).toBe("migrations");
  });
});
