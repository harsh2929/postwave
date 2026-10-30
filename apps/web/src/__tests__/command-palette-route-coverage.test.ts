// SPDX-License-Identifier: AGPL-3.0-only
//
// CI guard: every top-level (dashboard)/app/<segment> route that ships a static
// page.tsx must be reachable from the command palette route manifest. Pages
// that exist on disk but are absent from the palette are "orphans" — reachable
// only by typing the URL. This test enumerates the route segments from disk
// and asserts each one is present in the shared dashboard route manifest, so a
// new top-level page can never regress into an orphan.
//
// Scope is intentionally depth-1 (one segment under /app) plus the /app root.
// Deeper routes (e.g. /app/forms/new, /app/settings/api, dynamic [id] pages)
// are contextual — reached from within their parent feature — and are not
// expected to be standalone palette entries.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DASHBOARD_COMMAND_ROUTES,
  DASHBOARD_CREATE_ROUTES,
} from "../lib/dashboard-routes";

const APP_DIR = join(process.cwd(), "src", "app", "(dashboard)", "app");

/** Top-level navigable routes: /app plus each non-dynamic child dir with a page.tsx. */
function topLevelAppRoutes(): string[] {
  const routes = new Set<string>();
  for (const entry of readdirSync(APP_DIR, { withFileTypes: true })) {
    if (entry.name === "page.tsx") {
      routes.add("/app");
      continue;
    }
    if (entry.isDirectory() && !entry.name.startsWith("[")) {
      if (existsSync(join(APP_DIR, entry.name, "page.tsx"))) {
        routes.add(`/app/${entry.name}`);
      }
    }
  }
  return [...routes].sort();
}

function dashboardRouteFile(href: string): string | null {
  const pathname = new URL(href, "https://app.postwave.test").pathname;
  if (pathname === "/app") {
    return join(APP_DIR, "page.tsx");
  }
  if (!pathname.startsWith("/app/")) return null;
  return join(
    APP_DIR,
    ...pathname.slice("/app/".length).split("/"),
    "page.tsx",
  );
}

describe("command palette route coverage", () => {
  it("exposes every top-level /app route in the palette manifest", () => {
    const routes = topLevelAppRoutes();
    const hrefs = new Set<string>(
      DASHBOARD_COMMAND_ROUTES.map((route) => route.href),
    );

    // Sanity: we actually discovered the route tree and loaded the manifest.
    expect(routes.length).toBeGreaterThan(10);
    expect(hrefs.size).toBeGreaterThan(10);

    const orphans = routes.filter((r) => !hrefs.has(r));
    expect(
      orphans,
      `Orphaned (dashboard)/app routes missing from command-palette.tsx: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps quick-create route targets backed by shipped pages", () => {
    const missing = DASHBOARD_CREATE_ROUTES.map((route) => ({
      label: route.label,
      href: route.href,
      file: dashboardRouteFile(route.href),
    })).filter((route) => !route.file || !existsSync(route.file));

    expect(
      missing.map((route) => `${route.label}: ${route.href}`),
      "Quick-create command routes must point at existing dashboard pages.",
    ).toEqual([]);
  });
});
