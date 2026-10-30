// SPDX-License-Identifier: AGPL-3.0-only
//
// manifest.test.ts checks the manifest against ITSELF — unique keys, absolute
// paths, a route slot per surface, no duplicate routes. Every one of those can
// pass while an entry points at a screen that does not exist, because nothing
// here ever looked at the filesystem.
//
// That is not a hypothetical gap: @postwave/route-map, the sibling registry,
// ships scripts/check-route-map-destinations.mjs for exactly this reason, and
// its header records what happened without it — `/app/approvals/<id>` was
// minted for the dashboard resume card, the activity feed, "copy link" and
// mobile's continue-on-web handoff while apps/web shipped no `[id]` route, so
// all four produced a hard Next.js 404. nav had no equivalent check.
//
// A nav entry is worse than a deep link in one way: a deep link is followed by
// someone who was given it, but a nav item is rendered in the primary chrome of
// every session. A dead one is a permanently visible door that opens onto a 404.
//
// All 23 entries resolve today. This keeps it that way — a route renamed on one
// surface fails here rather than in someone's sidebar.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { NAV_ENTRIES, SURFACES, type Surface } from "./manifest.js";

const REPO = resolve(process.cwd(), "../..");

const WEB_ROOT = `${REPO}/apps/web/src/app/(dashboard)`;
const MOBILE_ROOT = `${REPO}/apps/mobile/app`;
const DESKTOP_ROUTER = `${REPO}/apps/desktop/src/lib/desktop-router.ts`;

/**
 * Whether a route resolves to a real screen on a surface.
 *
 * Each surface is checked the way that surface actually resolves routes, not by
 * a single guessed convention:
 *   web     — Next.js App Router: `<route>/page.tsx` under the (dashboard) group
 *   mobile  — expo-router: `<route>.tsx`, `<route>/index.tsx` or a route group
 *   desktop — its own section vocabulary, so membership in desktop-router.ts
 */
function routeResolves(surface: Surface, route: string): boolean {
  if (surface === "web") {
    return (
      existsSync(`${WEB_ROOT}${route}/page.tsx`) ||
      existsSync(`${WEB_ROOT}${route}/page.ts`)
    );
  }
  if (surface === "mobile") {
    return (
      existsSync(`${MOBILE_ROOT}${route}.tsx`) ||
      existsSync(`${MOBILE_ROOT}${route}/index.tsx`) ||
      existsSync(`${MOBILE_ROOT}${route}/_layout.tsx`)
    );
  }
  // Desktop parses `/app/<section>/…` against its own SECTION_SLUGS; `/app`
  // itself is the dashboard root and always resolves.
  const segments = route.split("/").filter(Boolean);
  if (segments[0] !== "app") return false;
  if (segments.length === 1) return true;
  return desktopSections().has(segments[1]!);
}

let cachedSections: Set<string> | null = null;
function desktopSections(): Set<string> {
  if (cachedSections) return cachedSections;
  const src = readFileSync(DESKTOP_ROUTER, "utf8");
  cachedSections = new Set(
    [...src.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!),
  );
  return cachedSections;
}

describe("every nav route points at a screen that exists", () => {
  it("has something to check on each surface", () => {
    // Guard the guard: a wrong root path makes every existsSync false, and a
    // broken manifest import makes the sweep empty. Either would otherwise be
    // reported as a clean run.
    expect(NAV_ENTRIES.length).toBeGreaterThan(10);
    expect(existsSync(WEB_ROOT), `web root missing: ${WEB_ROOT}`).toBe(true);
    expect(existsSync(MOBILE_ROOT), `mobile root missing: ${MOBILE_ROOT}`).toBe(
      true,
    );
    expect(desktopSections().size).toBeGreaterThan(5);
  });

  it("resolves every non-null route on every surface", () => {
    const dead: string[] = [];
    for (const entry of NAV_ENTRIES) {
      for (const surface of SURFACES) {
        const route = entry.routes[surface];
        if (route === null) continue;
        if (!routeResolves(surface, route)) {
          dead.push(`${entry.key} → ${surface} ${route}`);
        }
      }
    }
    expect(
      dead,
      "these nav entries render a door that opens onto nothing",
    ).toEqual([]);
  });

  it("proves the resolver can actually fail", () => {
    // Without this, a resolver that returned true unconditionally would report
    // every route healthy forever.
    expect(routeResolves("web", "/app/definitely-not-a-real-route")).toBe(false);
    expect(routeResolves("mobile", "/(tabs)/definitely-not-real")).toBe(false);
    expect(routeResolves("desktop", "/app/definitely-not-real")).toBe(false);
    expect(routeResolves("desktop", "/not-app/x")).toBe(false);
  });
});
