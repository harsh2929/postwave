/**
 * A component authored for a screen must be mounted by one.
 *
 * MOB-UNW-02: PresenceBar was written, styled, accessibility-labelled and
 * covered by its own render test while ZERO screens rendered it. The whole
 * point of the sweep it belongs to was to find features that are built but not
 * wired, and the sweep shipped one of its own — because every test in the
 * repository imported the component directly, and a component test cannot
 * notice that its component has no call site.
 *
 * `__tests__/presence-mount.native.test.tsx` is the behavioural half of the
 * fix: it renders the dashboard SCREEN and asserts the sentence reaches the
 * tree. This is the cheap structural net beside it — a filesystem scan, like
 * routeErrorBoundary.consistency.test.ts, that runs under node in
 * milliseconds and fails the moment the last call site disappears, whatever
 * the reason.
 *
 * It is deliberately a scan and not an import: route modules pull in
 * react-native and expo-router, neither of which loads in the node vitest
 * environment.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const MOBILE_ROOT = join(__dirname, "..", "..");
const APP_DIR = join(MOBILE_ROOT, "app");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      tsxFiles(full, out);
      continue;
    }
    if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Rendered as JSX, not merely imported: an unused import is not a mount. */
const RENDERS_PRESENCE = /<PresenceBar[\s/>]/u;
const IMPORTS_PRESENCE = /from\s+"@\/components\/PresenceBar"/u;

describe("PresenceBar reachability", () => {
  const files = tsxFiles(APP_DIR).sort();

  it("finds the route tree (guards against a silently-empty scan)", () => {
    // A path typo would make the assertion below pass vacuously — which is
    // the exact shape of the bug this file exists to catch.
    expect(files.length).toBeGreaterThan(40);
  });

  it("is imported AND rendered by at least one route module", () => {
    const mounts = files.filter((file) => {
      const src = readFileSync(file, "utf8");
      return IMPORTS_PRESENCE.test(src) && RENDERS_PRESENCE.test(src);
    });

    expect(
      mounts.map((file) => relative(MOBILE_ROOT, file)),
      "PresenceBar is rendered by no screen. Presence is subscribed, parsed " +
        "and stored regardless (src/lib/eventCacheSync.ts), so an unmounted " +
        "component means the app holds colleague identities it never shows.",
    ).not.toHaveLength(0);
  });

  it("is mounted on exactly one screen", () => {
    // Presence is WORKSPACE-scoped and advisory. Repeating it on every tab
    // would say the same sentence seventy times; the component header records
    // why the dashboard is the one screen that earns it. A second mount is a
    // decision, not a typo — so it fails here and gets argued rather than
    // arriving by copy-paste.
    const mounts = files
      .filter((file) => RENDERS_PRESENCE.test(readFileSync(file, "utf8")))
      .map((file) => relative(MOBILE_ROOT, file));

    expect(mounts).toEqual(["app/(tabs)/dashboard.tsx"]);
  });
});
