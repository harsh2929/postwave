/**
 * Every route module must declare its own ErrorBoundary.
 *
 * Expo Router mounts a named `ErrorBoundary` export from a route module as the
 * boundary for THAT route. Until this sweep, exactly one existed —
 * `app/_layout.tsx` — which is the ROOT. A render-time throw in any single
 * screen (an unexpected API shape, a null a defensive parse missed) therefore
 * replaced the entire app: the tab bar vanished along with every other tab's
 * scroll position and query state, and the only way out was one button.
 *
 * With a per-route boundary the same throw degrades that one screen and leaves
 * the shell — and every escape route — intact.
 *
 * This test is a FILESYSTEM scan rather than an import: route modules pull in
 * react-native and expo-router, neither of which loads in the node vitest
 * environment. Scanning the text is exactly enough to prove the export exists,
 * and it fails the build the moment a new route file is added without one,
 * which is the only way a sweep like this stays swept.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP_DIR = join(__dirname, "..", "..", "app");

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      routeFiles(full, out);
      continue;
    }
    if (!entry.endsWith(".tsx")) continue;
    // Layouts are the PARENT of the routes below them: a boundary there would
    // catch a child's throw and take its siblings down with it, which is the
    // very behaviour being fixed. `app/_layout.tsx` keeps the root boundary as
    // the last line of defence and is asserted separately below.
    if (entry === "_layout.tsx") continue;
    // Expo invokes this convention module as a URL-rewrite hook; it exports no
    // React screen for an ErrorBoundary to wrap. Its exported function is
    // loaded and exercised by native-intent-route.native.test.ts instead.
    if (entry === "+native-intent.tsx") continue;
    out.push(full);
  }
  return out;
}

const BOUNDARY = /\bas ErrorBoundary\b/u;

describe("per-route error boundaries", () => {
  const files = routeFiles(APP_DIR).sort();

  it("finds the route tree (guards against a silently-empty scan)", () => {
    // A path typo would make every assertion below pass vacuously.
    expect(files.length).toBeGreaterThan(40);
  });

  it("declares an ErrorBoundary on every route module", () => {
    const missing = files
      .filter((file) => !BOUNDARY.test(readFileSync(file, "utf8")))
      .map((file) => relative(APP_DIR, file));
    expect(missing).toEqual([]);
  });

  it("keeps the ROOT boundary as the last line of defence", () => {
    const root = readFileSync(join(APP_DIR, "_layout.tsx"), "utf8");
    expect(BOUNDARY.test(root)).toBe(true);
  });
});
