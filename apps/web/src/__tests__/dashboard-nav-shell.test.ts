// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import {
  DASHBOARD_NAV_ITEMS,
  activeDashboardNavItem,
  isActive,
  nextDashboardNavIndex,
} from "../app/(dashboard)/dashboard-nav-shell";
import {
  DASHBOARD_NAV,
  DASHBOARD_NAV_COLLECTION_RULES,
  DASHBOARD_NAV_COLLECTIONS,
} from "../lib/dashboard-nav";

describe("dashboard nav shell helpers", () => {
  it("matches exact and nested dashboard routes without prefix smuggling", () => {
    expect(DASHBOARD_NAV_ITEMS.length).toBeGreaterThan(0);
    expect(isActive("/app", "/app")).toBe(true);
    expect(isActive("/app/campaigns", "/app/campaigns")).toBe(true);
    expect(isActive("/app/campaigns/123", "/app/campaigns")).toBe(true);
    expect(isActive("/application", "/app")).toBe(false);
    expect(isActive("/app-campaigns", "/app")).toBe(false);
    expect(isActive("/app/campaigns-old", "/app/campaigns")).toBe(false);
  });

  it("computes roving-focus indexes for keyboard navigation", () => {
    expect(nextDashboardNavIndex("ArrowDown", 1, 4)).toBe(2);
    expect(nextDashboardNavIndex("ArrowDown", 3, 4)).toBe(0);
    expect(nextDashboardNavIndex("ArrowUp", 0, 4)).toBe(3);
    expect(nextDashboardNavIndex("Home", 2, 4)).toBe(0);
    expect(nextDashboardNavIndex("End", 2, 4)).toBe(3);
    expect(nextDashboardNavIndex("Enter", 2, 4)).toBeNull();
    expect(nextDashboardNavIndex("ArrowDown", 0, 0)).toBeNull();
  });

  it("selects the most-specific active destination and stays truthful on palette-only routes", () => {
    expect(activeDashboardNavItem("/app/custom-objects/record_1")?.href).toBe(
      "/app/custom-objects",
    );
    expect(activeDashboardNavItem("/app/settings/developer")?.href).toBe(
      "/app/settings",
    );
    expect(activeDashboardNavItem("/app/notifications")).toBeNull();
  });
});

describe("dashboard nav information architecture", () => {
  it("assigns every sidebar route to one intentional collection exactly once", () => {
    const routeHrefs = DASHBOARD_NAV.map((item) => item.href);
    const ruleHrefs = DASHBOARD_NAV_COLLECTION_RULES.flatMap(
      (collection) => collection.hrefs,
    );
    const renderedHrefs = DASHBOARD_NAV_COLLECTIONS.flatMap((collection) =>
      collection.items.map((item) => item.href),
    );

    expect(new Set(routeHrefs).size).toBe(routeHrefs.length);
    expect(new Set(ruleHrefs).size).toBe(ruleHrefs.length);
    expect(new Set(renderedHrefs).size).toBe(renderedHrefs.length);
    expect([...ruleHrefs].sort()).toEqual([...routeHrefs].sort());
    expect([...renderedHrefs].sort()).toEqual([...routeHrefs].sort());
    expect(
      DASHBOARD_NAV_COLLECTIONS.some((collection) =>
        collection.key.endsWith("-more"),
      ),
    ).toBe(false);
  });

  it("uses concise, unique collection names and never crosses canonical groups", () => {
    const labels = DASHBOARD_NAV_COLLECTIONS.map(
      (collection) => collection.label,
    );
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual([
      "Core workspace",
      "Operations",
      "Data & automation",
      "Create",
      "Engage",
      "Optimize & connect",
      "Monitor",
      "Protect",
      "Workspace management",
      "Governance & privacy",
      "Data infrastructure",
    ]);
    for (const collection of DASHBOARD_NAV_COLLECTIONS) {
      expect(collection.items.length).toBeGreaterThan(0);
      expect(
        collection.items.every((item) => item.group === collection.group),
      ).toBe(true);
    }
  });
});
