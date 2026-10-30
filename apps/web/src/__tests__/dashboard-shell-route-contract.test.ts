import { describe, expect, it } from "vitest";
import { NAV_ENTRIES } from "@postwave/nav";

import { DASHBOARD_NAV_ROUTES, DASHBOARD_ROUTES } from "@/lib/dashboard-routes";
import {
  DASHBOARD_SHELL_ADMIN_ROUTE_HREFS,
  DASHBOARD_SHELL_ROUTES,
} from "@/lib/dashboard-shell-routes";
import {
  DASHBOARD_SHELL_NAV_ROUTES,
  dashboardShellRouteRequiresAdmin as compactRouteRequiresAdmin,
} from "@/lib/dashboard-shell-nav-routes";

describe("dashboard shell route projection", () => {
  it("retains every canonical recent-destination label and sidebar field", () => {
    const expectedRoutes = DASHBOARD_ROUTES.map(
      ({ label, href, icon, group, sidebar }) => ({
        label,
        href,
        ...(sidebar ? { icon, group, sidebar: true as const } : {}),
      }),
    );

    expect(DASHBOARD_SHELL_ROUTES).toEqual(expectedRoutes);
    expect(DASHBOARD_SHELL_NAV_ROUTES).toEqual(
      expectedRoutes.filter((route) => route.sidebar === true),
    );
    expect(DASHBOARD_SHELL_NAV_ROUTES).toEqual(
      DASHBOARD_NAV_ROUTES.map(({ label, href, icon, group }) => ({
        label,
        href,
        icon,
        group,
        sidebar: true,
      })),
    );
  });

  it("names the sanitized discount surface as history across navigation and search", () => {
    const route = DASHBOARD_ROUTES.find(
      (candidate) => candidate.href === "/app/discounts",
    );
    const shellRoute = DASHBOARD_SHELL_ROUTES.find(
      (candidate) => candidate.href === "/app/discounts",
    );

    expect(route).toMatchObject({
      label: "Discount history",
      keywords: ["history", "archive", "stored terms", "recorded uses"],
    });
    expect(shellRoute?.label).toBe("Discount history");
    expect(route?.keywords).not.toEqual(
      expect.arrayContaining(["coupon", "promo", "code", "voucher"]),
    );
  });

  it("projects Commerce into the growth rail with its canonical admin scope", () => {
    expect(
      DASHBOARD_ROUTES.find((route) => route.href === "/app/commerce"),
    ).toMatchObject({
      label: "Commerce",
      icon: "creditCard",
      group: "growth",
      sidebar: true,
      scope: "admin",
    });
    expect(
      DASHBOARD_SHELL_NAV_ROUTES.find(
        (route) => route.href === "/app/commerce",
      ),
    ).toMatchObject({
      label: "Commerce",
      icon: "creditCard",
      group: "growth",
      sidebar: true,
    });
  });

  it("keeps the lightweight admin projection identical to the manifest", () => {
    const shellHrefs = new Set<string>(
      DASHBOARD_SHELL_ROUTES.map((route) => route.href),
    );
    const expected = NAV_ENTRIES.filter(
      (entry) =>
        entry.scope === "admin" &&
        typeof entry.routes.web === "string" &&
        shellHrefs.has(entry.routes.web),
    ).map((entry) => entry.routes.web);
    expect(DASHBOARD_SHELL_ADMIN_ROUTE_HREFS).toEqual(expected);
    for (const route of DASHBOARD_SHELL_NAV_ROUTES) {
      expect(compactRouteRequiresAdmin(route.href), route.href).toBe(
        expected.includes(route.href),
      );
    }
  });
});
