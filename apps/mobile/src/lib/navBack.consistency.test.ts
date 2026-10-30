/**
 * Back-navigation consistency.
 *
 * `goBackOrMore()` exists precisely because `router.back()` is a SILENT NO-OP
 * when there is no history — and the screens most likely to be entered cold are
 * exactly the ones that used it: a notification tap lands on an entity, a QR
 * scan opens the device-approval screen, and the header magnifier opens Search
 * with no stack behind it. On those screens the back chevron simply did
 * nothing, with no other way out.
 *
 * This is the guard the fix was missing: any screen that renders a back chevron
 * must route it through `goBackOrMore` / `goBackOr`, or guard `router.back()`
 * with `router.canGoBack()` itself.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = resolve(process.cwd());
const tabsRoot = join(appRoot, "app");

function routeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    if (!path.endsWith(".tsx")) return [];
    if (/\.(?:test|spec)\.tsx$/u.test(path)) return [];
    return [path];
  });
}

/** `onBack={() => router.back()}` — the exact stranding pattern. */
const RAW_BACK = /onBack=\{\s*\(\s*\)\s*=>\s*router\.back\(\s*\)\s*\}/u;
/**
 * `router.replace(...)` is history-independent, so a chevron wired to it can
 * never be a no-op — the auth screens legitimately use it to send the user to
 * a fixed destination.
 */
const SAFE_BACK = /goBackOrMore|goBackOr\b|router\.canGoBack\(|router\.replace\(/u;

describe("back navigation", () => {
  const withBackChevron = routeFiles(tabsRoot).filter((path) =>
    readFileSync(path, "utf8").includes("onBack"),
  );

  it("finds the screens that render a back chevron", () => {
    // A sanity floor: if this collapses to zero the scan silently stopped
    // testing anything, which is how guards rot.
    expect(withBackChevron.length).toBeGreaterThan(10);
  });

  it("never wires a bare router.back() to the chevron", () => {
    const offenders = withBackChevron
      .filter((path) => RAW_BACK.test(readFileSync(path, "utf8")))
      .map((path) => relative(appRoot, path));
    expect(offenders).toEqual([]);
  });

  it("routes every back chevron through a history-aware helper", () => {
    // A screen satisfies this either directly, or through the controller hook
    // it delegates to. Several screens keep no logic of their own — the
    // sending-settings surface was split into a controller hook plus render
    // components precisely to stay inside its complexity budget — so a
    // same-file scan would report a chevron as unguarded while the helper sits
    // one import away. Resolving ONE level of local indirection keeps the
    // guard's meaning (a chevron must never be a silent no-op) without
    // punishing that decomposition.
    // A screen satisfies this either directly, or through the controller hook
    // chain it delegates to. Several screens keep no logic of their own — the
    // sending-settings surface is a render shell over a controller hook, which
    // itself delegates its writes to a second hook — so a same-file scan would
    // report a chevron as unguarded while the helper sits two imports away.
    // Following the chain (bounded, cycle-safe) keeps the guard's meaning — a
    // chevron must never be a silent no-op — without punishing decomposition.
    const resolvesSafely = (path: string, depth = 0, chain: string[] = []): boolean => {
      // `chain` is the current path only — a cycle guard, NOT a failure cache.
      // Sharing one visited set across sibling branches memoised a rejection
      // made at the depth limit, so a file reachable both deeply and shallowly
      // was wrongly reported unguarded.
      if (depth > 3 || chain.includes(path)) return false;
      if (!existsSync(path)) return false;
      const source = readFileSync(path, "utf8");
      if (SAFE_BACK.test(source)) return true;
      for (const spec of source.matchAll(/from "@\/((?:hooks|lib|components)\/[\w./-]+)"/gu)) {
        const target = spec[1];
        if (!target) continue;
        for (const ext of [".ts", ".tsx"]) {
          if (resolvesSafely(join(appRoot, "src", `${target}${ext}`), depth + 1, [
              ...chain,
              path,
            ])) {
            return true;
          }
        }
      }
      return false;
    };
    const offenders = withBackChevron
      .filter((path) => !resolvesSafely(path))
      .map((path) => relative(appRoot, path));
    expect(offenders).toEqual([]);
  });
});
