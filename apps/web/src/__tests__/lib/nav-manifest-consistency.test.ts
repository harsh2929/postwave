// SPDX-License-Identifier: AGPL-3.0-only
//
// Consistency guard between the web dashboard sidebar (@/lib/dashboard-nav)
// and the shared @postwave/nav manifest.
//
// The manifest is the single source of truth for the cross-surface
// information architecture (canonical labels + per-surface routes). This
// test does NOT rewrite the web nav tree — web still owns its order and a
// few surface-only routes — but it asserts that wherever web and the
// manifest model the SAME route, they agree on the canonical label, so the
// two cannot silently diverge. New manifest-modelled web routes must be
// added to web's nav (or this list updated deliberately).

import { describe, expect, it } from "vitest";
import { NAV_ENTRIES, navForSurface } from "@postwave/nav";

import { DASHBOARD_NAV } from "../../lib/dashboard-nav";
import { DASHBOARD_ROUTES } from "../../lib/dashboard-routes";

/**
 * Routes the web sidebar surfaces that the manifest does NOT (yet) model.
 * Documented so an unexpected new web route fails the "subset" assertion
 * below and forces a conscious decision (add to manifest, or allowlist).
 */
/**
 * Manifest web routes deliberately treated as unreachable from nav. Empty, and
 * kept as a named binding so the stale-declaration test below has something to
 * check — see that test for why both former entries were removed.
 */
const KNOWN_ORPHANS_EXPORTED = new Set<string>([]);

const WEB_ONLY_ROUTES = new Set<string>([
  "/app/pilot",
  "/app/compatibility",
  // Content/capture surfaces shipped on web but not (yet) modelled by the
  // shared @postwave/nav manifest. Landing Pages was reachable only via the
  // command palette; Inbound Webhooks had a triggers sub-page but no index —
  // both are now linked from the sidebar.
  // Visual flow-builder (automation journeys). Shipped on web ahead of the
  // shared @postwave/nav manifest modelling it.
]);

/** Manifest web routes keyed by route → canonical label. */
const manifestWebByRoute = new Map<string, string>(
  NAV_ENTRIES.filter((e) => typeof e.routes.web === "string").map((e) => [
    e.routes.web as string,
    e.label,
  ]),
);

describe("web nav ↔ @postwave/nav manifest consistency", () => {
  it("every web nav route is either modelled by the manifest or an allowlisted web-only route (subset check)", () => {
    const stray = DASHBOARD_NAV.filter(
      (item) =>
        !manifestWebByRoute.has(item.href) && !WEB_ONLY_ROUTES.has(item.href),
    ).map((i) => i.href);
    expect(stray, `unmodelled web nav routes: ${stray.join(", ")}`).toEqual([]);
  });

  it("shared routes carry the manifest's canonical label (no label drift)", () => {
    // Web's "Overview" is the manifest's "Dashboard" for /app — the manifest
    // is the source of truth, but web deliberately keeps "Overview" today.
    // Allow that single documented exception; everything else must match.
    const LABEL_EXCEPTIONS: Record<string, string> = {
      "/app": "Overview", // manifest: "Dashboard"
    };
    for (const item of DASHBOARD_NAV) {
      const canonical = manifestWebByRoute.get(item.href);
      if (!canonical) continue; // web-only route, skip
      const expected = LABEL_EXCEPTIONS[item.href] ?? canonical;
      expect(item.label, `label for ${item.href}`).toBe(expected);
    }
  });

  it("manifest member-scope web entries are reachable from the web nav, modulo known orphans", () => {
    // Analytics was the audit's orphan example: shipped on web but absent
    // from the sidebar. Assert every member-scoped manifest entry the
    // manifest exposes on web has a corresponding web nav route, minus a
    // documented set of still-orphaned routes (rewriting the nav to add
    // these is deliberately out of scope for the adoption refactor).
    // Empty, and guarded below. Both former entries were stale: the manifest
    // routes approvals to /app/approvals (so "/app/settings/approvals" was a
    // string nothing produced), and /app/integrations is palette-reachable, so
    // the sidebar-or-palette rule already covers it. The desktop half of this
    // change got a stale-declaration test and this half did not — which is how
    // an allowlist quietly becomes a list of things nobody rechecked.
    const KNOWN_ORPHANS = KNOWN_ORPHANS_EXPORTED;
    // Reachable from the SIDEBAR **or** the ⌘K palette. The manifest models
    // cross-surface nav concepts, and web deliberately keeps some of them off
    // the sidebar — /app/notifications is the bell's history page, and
    // /app/sequence-templates is a palette-only utility. Asserting sidebar
    // membership alone made "modelled by the manifest" mean "must be a sidebar
    // item", which is a stricter claim than the manifest makes and one the
    // nav-destination guard already contradicts (it counts the palette as nav).
    const webRoutes = new Set([
      ...DASHBOARD_NAV.map((i) => i.href),
      ...DASHBOARD_ROUTES.filter((r) => r.commandGroup !== undefined).map(
        (r) => r.href,
      ),
    ]);
    const missing = navForSurface("web", { scope: "member" })
      .map((e) => e.routes.web as string)
      .filter((r) => !KNOWN_ORPHANS.has(r))
      .filter((r) => !webRoutes.has(r));
    expect(
      missing,
      `manifest web entries reachable from neither sidebar nor palette: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    // An excuse that no longer describes anything excuses nothing, and hides
    // the next real gap behind it.
    const manifestWebRoutes = new Set(
      NAV_ENTRIES.map((e) => e.routes.web).filter(
        (r): r is string => typeof r === "string",
      ),
    );
    const reachable = new Set([
      ...DASHBOARD_NAV.map((i) => i.href),
      ...DASHBOARD_ROUTES.filter((r) => r.commandGroup !== undefined).map(
        (r) => r.href,
      ),
    ]);
    const staleOrphans = [...KNOWN_ORPHANS_EXPORTED].filter(
      (r) => !manifestWebRoutes.has(r) || reachable.has(r),
    );
    expect(
      staleOrphans,
      `KNOWN_ORPHANS entries that are no longer orphans (or were never manifest routes): ${staleOrphans.join(", ")}`,
    ).toEqual([]);

    const staleWebOnly = [...WEB_ONLY_ROUTES].filter((r) =>
      manifestWebRoutes.has(r),
    );
    expect(
      staleWebOnly,
      `WEB_ONLY_ROUTES entries the manifest now models: ${staleWebOnly.join(", ")}`,
    ).toEqual([]);
  });
});
