import { describe, expect, it } from "vitest";

import {
  MOBILE_QUICK_ACTIONS,
  quickActionsForAudience,
  routeForQuickActionId,
} from "./quickActionPolicy";

describe("MOBILE_QUICK_ACTIONS", () => {
  it("fits inside the OS ceiling of four shortcuts", () => {
    // iOS silently drops the overflow, so a fifth entry would be a menu item
    // that exists in code and never on a device.
    expect(MOBILE_QUICK_ACTIONS.length).toBeLessThanOrEqual(4);
  });

  it("uses unique, stable ids", () => {
    const ids = MOBILE_QUICK_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("points every action at a tab route", () => {
    for (const action of MOBILE_QUICK_ACTIONS) {
      expect(action.href.startsWith("/(tabs)/")).toBe(true);
      expect(action.title.length).toBeGreaterThan(0);
      expect(action.subtitle.length).toBeGreaterThan(0);
    }
  });
});

describe("quickActionsForAudience", () => {
  it("publishes nothing at all while signed out", () => {
    expect(
      quickActionsForAudience({ signedIn: false, role: "owner", mode: "session" }),
    ).toEqual([]);
  });

  it("hides Approvals from a viewer", () => {
    // approvals/handlers.go:226 calls requireAdmin — owner|admin only. A
    // viewer shortcut would be a home-screen link to a 403.
    const ids = quickActionsForAudience({
      signedIn: true,
      role: "viewer",
      mode: "session",
    }).map((a) => a.id);
    expect(ids).not.toContain("approvals");
    expect(ids).toContain("search");
  });

  it("offers Approvals to an admin and an owner", () => {
    for (const role of ["admin", "owner"]) {
      const ids = quickActionsForAudience({
        signedIn: true,
        role,
        mode: "session",
      }).map((a) => a.id);
      expect(ids).toContain("approvals");
    }
  });

  it("withholds role-gated actions from an api-key session", () => {
    // The mobile login response carries no API-key scopes, so the manifest
    // default-denies anything above viewer rather than rendering a control
    // that issues a predictable 403.
    const ids = quickActionsForAudience({
      signedIn: true,
      role: "owner",
      mode: "api_key",
    }).map((a) => a.id);
    expect(ids).not.toContain("approvals");
    expect(ids).toContain("scan");
  });

  it("treats an unknown role as not-admin rather than as owner", () => {
    const ids = quickActionsForAudience({
      signedIn: true,
      role: "something-new",
      mode: "session",
    }).map((a) => a.id);
    expect(ids).not.toContain("approvals");
  });
});

describe("routeForQuickActionId", () => {
  it("resolves a published id", () => {
    expect(routeForQuickActionId("search")).toBe("/(tabs)/search");
  });

  it("returns null for an id minted by an older build", () => {
    expect(routeForQuickActionId("compose-campaign")).toBeNull();
    expect(routeForQuickActionId("")).toBeNull();
    expect(routeForQuickActionId(null)).toBeNull();
    expect(routeForQuickActionId(undefined)).toBeNull();
    expect(routeForQuickActionId(7 as unknown as string)).toBeNull();
  });
});
