/**
 * screenViewedCoverage — the guard for "which screens report being viewed".
 *
 * `useScreenViewed` existed and was mounted on most of the app, but fourteen
 * secondary destinations never got it — including EVERY entity-detail route
 * (campaign, list, segment, subscriber), Search, Settings, Notifications and
 * Analytics. Nothing failed when a new screen shipped without it, so the set
 * drifted silently: the hook's own docstring describes the gap it was written
 * to close, and the gap had quietly reopened.
 *
 * Two things record a view, and this file asserts BOTH, because between them
 * they are the whole picture:
 *
 *   1. Secondary screens call `useScreenViewed(...)` on mount.
 *   2. The five PRIMARY tabs cannot — they are registered by the (tabs) layout
 *      and their bodies are shared with nested navigators — so the layout
 *      records them from a `focus` listener. `tabPress` alone was not enough:
 *      it fires only for a finger on the rail, so a cold start or a deep link
 *      into Dashboard/Campaigns/Approvals recorded nothing at all.
 *
 * HOW THE COVERAGE CHECK RESOLVES (be precise about this — a guard that
 * over-claims is worse than none). A route file frequently does not call the
 * hook itself: `app/(tabs)/commerce.tsx` is a two-line re-export of
 * `src/components/commerce/CommerceScreen.tsx`, and THAT is where the call
 * lives. So this walks the import graph TRANSITIVELY: it parses every
 * `from "…"` / `import("…")` specifier in `src/` and `app/`, resolves `@/` and
 * relative paths (trying `.ts`, `.tsx`, `/index.ts`, `/index.tsx`), and marks a
 * route covered if the hook is reachable from it at any depth.
 *
 * It is a TEXTUAL graph, not a type-aware one. It cannot see through a bare
 * package specifier (nothing outside this app calls the hook) or a dynamic
 * `import(variable)`. A "direct hit" requires BOTH the import specifier
 * `@/hooks/useScreenViewed` and a `useScreenViewed(` call — a prose mention
 * alone does not count, which is what makes
 * `src/lib/commerceTelemetry.ts` ("emitted by useScreenViewed", a comment) a
 * miss rather than a false pass.
 *
 * The exemptions below are the honest part: `_layout.tsx` files are
 * navigators, not screens, and `access-denied.tsx` is a guard overlay that is
 * never a destination anyone navigates to on purpose.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const MOBILE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SRC_DIR = path.join(MOBILE_ROOT, "src");
const APP_DIR = path.join(MOBILE_ROOT, "app");
const TABS_DIR = path.join(APP_DIR, "(tabs)");
const HOOK_FILE = path.join(SRC_DIR, "hooks", "useScreenViewed.ts");
const TABS_LAYOUT = path.join(TABS_DIR, "_layout.tsx");

/**
 * The five destinations on the bottom rail. Their view events come from the
 * layout's `focus` listeners, not from the hook.
 */
const PRIMARY_TABS = [
  "dashboard",
  "subscribers",
  "campaigns",
  "approvals",
  "more",
] as const;

/** Route files inside those five families whose views the layout records. */
const PRIMARY_TAB_ROUTES = new Set([
  "app/(tabs)/dashboard.tsx",
  "app/(tabs)/more.tsx",
  "app/(tabs)/approvals/index.tsx",
  "app/(tabs)/campaigns/index.tsx",
  "app/(tabs)/subscribers/index.tsx",
]);

/**
 * Not screens. `_layout.tsx` files are navigators — they render children, they
 * are not a destination. `access-denied.tsx` is the role-denial target the
 * SecondaryRouteGuard REPLACES a forbidden screen with; counting it as a
 * viewed screen would put a denial in the same series as a deliberate visit.
 */
function isExempt(rel: string): boolean {
  return rel.endsWith("/_layout.tsx") || rel === "app/(tabs)/access-denied.tsx";
}

function listModules(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules")
          continue;
        stack.push(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      out.push(full);
    }
  }
  return out.sort();
}

const EXTENSION_CANDIDATES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveSpecifier(specifier: string, importer: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(SRC_DIR, specifier.slice(2));
  else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(importer), specifier);
  } else return null; // a package — nothing outside this app calls the hook.
  for (const ext of EXTENSION_CANDIDATES) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

const SPECIFIER_RE = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;

type Graph = {
  /** file -> the files it imports (in-repo only). */
  readonly imports: ReadonlyMap<string, readonly string[]>;
  /** every file that itself imports AND calls the hook. */
  readonly directHits: ReadonlySet<string>;
};

function buildGraph(): Graph {
  const files = [...listModules(SRC_DIR), ...listModules(APP_DIR)];
  const imports = new Map<string, string[]>();
  const directHits = new Set<string>();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    // The definition file is excluded deliberately: it declares the hook but
    // does not report a view, and treating it as a hit would mark every module
    // that merely IMPORTS the hook — including one that forgot to call it.
    if (
      file !== HOOK_FILE &&
      source.includes("@/hooks/useScreenViewed") &&
      /\buseScreenViewed\s*\(/.test(source)
    ) {
      directHits.add(file);
    }
    const edges: string[] = [];
    for (const match of source.matchAll(SPECIFIER_RE)) {
      const resolved = resolveSpecifier(match[1] as string, file);
      if (resolved !== null) edges.push(resolved);
    }
    imports.set(file, edges);
  }
  return { imports, directHits };
}

/**
 * Reverse-propagate from the direct hits to a fixpoint, rather than walking
 * forward from each route: it visits every edge once instead of once per
 * route, and it terminates on an import cycle without special-casing one.
 */
function coveredFiles(graph: Graph): Set<string> {
  const importers = new Map<string, string[]>();
  for (const [file, edges] of graph.imports) {
    for (const edge of edges) {
      const list = importers.get(edge);
      if (list === undefined) importers.set(edge, [file]);
      else list.push(file);
    }
  }
  const covered = new Set<string>(graph.directHits);
  const queue = [...graph.directHits];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const importer of importers.get(current) ?? []) {
      if (covered.has(importer)) continue;
      covered.add(importer);
      queue.push(importer);
    }
  }
  return covered;
}

const graph = buildGraph();
const covered = coveredFiles(graph);
const routeFiles = listModules(TABS_DIR).map((file) =>
  path.relative(MOBILE_ROOT, file),
);

describe("screen-view telemetry coverage", () => {
  it("finds a plausible number of (tabs) routes", () => {
    // If the walker is pointed at the wrong directory it reports zero misses
    // out of zero routes and passes forever.
    expect(routeFiles.length).toBeGreaterThan(60);
    expect(routeFiles).toContain("app/(tabs)/search.tsx");
    expect(routeFiles).toContain("app/(tabs)/campaigns/[id].tsx");
  });

  it("does not report coverage it cannot see (the walker is falsifiable)", () => {
    // A guard that answers "covered" for everything proves nothing. These two
    // are known-uncovered by construction and MUST come back as misses.
    expect(covered.has(path.join(TABS_DIR, "access-denied.tsx"))).toBe(false);
    expect(covered.has(path.join(SRC_DIR, "lib", "commerceTelemetry.ts"))).toBe(
      false,
    );
  });

  it("resolves the hook transitively, not only in the route file itself", () => {
    // app/(tabs)/commerce.tsx re-exports a screen body that calls the hook. A
    // route-file-only check would call this a miss; the walker must not.
    const screen = path.join(
      SRC_DIR,
      "components",
      "commerce",
      "CommerceScreen.tsx",
    );
    expect(graph.directHits.has(screen)).toBe(true);
    expect(covered.has(path.join(TABS_DIR, "commerce.tsx"))).toBe(true);
    expect(
      fs.readFileSync(path.join(TABS_DIR, "commerce.tsx"), "utf8"),
    ).not.toMatch(/\buseScreenViewed\s*\(/);
  });

  it("every (tabs) screen reports a view", () => {
    const missing = routeFiles.filter((rel) => {
      if (isExempt(rel)) return false;
      if (PRIMARY_TAB_ROUTES.has(rel)) return false; // asserted below instead.
      return !covered.has(path.join(MOBILE_ROOT, rel));
    });
    expect(missing).toEqual([]);
  });

  it("the fourteen routes this guard was written for are covered", () => {
    // Named explicitly so a future refactor that drops one of them fails with
    // the name in the message, not as an anonymous entry in a list of 80.
    const routes = [
      "app/(tabs)/analytics.tsx",
      "app/(tabs)/campaigns/[id].tsx",
      "app/(tabs)/campaigns/[id]/ab-results.tsx",
      "app/(tabs)/cli-approve.tsx",
      "app/(tabs)/diagnostics.tsx",
      "app/(tabs)/lists/index.tsx",
      "app/(tabs)/lists/[id].tsx",
      "app/(tabs)/notifications.tsx",
      "app/(tabs)/search.tsx",
      "app/(tabs)/segments/index.tsx",
      "app/(tabs)/segments/[id].tsx",
      "app/(tabs)/settings.tsx",
      "app/(tabs)/subscribers/[id].tsx",
      "app/(tabs)/tags.tsx",
    ];
    for (const rel of routes) {
      expect(routeFiles, `${rel} is not a route any more`).toContain(rel);
      expect(
        covered.has(path.join(MOBILE_ROOT, rel)),
        `${rel} no longer reports a screen view`,
      ).toBe(true);
    }
  });
});

describe("the primary tabs record a view on focus, not only on press", () => {
  const layout = fs.readFileSync(TABS_LAYOUT, "utf8");

  it("registers a focus listener for all five rail destinations", () => {
    for (const tab of PRIMARY_TABS) {
      expect(
        layout,
        `${tab} has no focus listener, so a cold start / deep link into it is invisible`,
      ).toContain(`focus: onTabFocus("${tab}")`);
    }
  });

  it("the focus listener is what emits, and the press listener is not", () => {
    // The regression this pins: moving the emit back onto `tabPress` (or
    // dropping it from `focus`) restores the original blindness.
    const focusBody = /function onTabFocus\([^)]*\)[^{]*\{[\s\S]*?\n\}/.exec(
      layout,
    );
    expect(focusBody).not.toBeNull();
    expect((focusBody as RegExpExecArray)[0]).toContain("trackTabView(tab)");

    const pressBody = /function onTabPress\([^)]*\)[^{]*\{[\s\S]*?\n\}/.exec(
      layout,
    );
    expect(pressBody).not.toBeNull();
    expect((pressBody as RegExpExecArray)[0]).toContain("haptics.tap()");
    expect((pressBody as RegExpExecArray)[0]).not.toContain("trackTabView");
  });

  it("every primary-tab route is accounted for by exactly one mechanism", () => {
    // Belt and braces: if someone adds useScreenViewed to dashboard.tsx as
    // well, the tab would be counted twice per visit. Catch that here rather
    // than in a dashboard funnel six weeks later.
    for (const rel of PRIMARY_TAB_ROUTES) {
      expect(routeFiles, `${rel} is not a route any more`).toContain(rel);
      expect(
        covered.has(path.join(MOBILE_ROOT, rel)),
        `${rel} now emits from BOTH useScreenViewed and the layout focus listener`,
      ).toBe(false);
    }
  });
});
