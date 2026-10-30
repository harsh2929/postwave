/**
 * The redirect that keeps PostHog's UI tree out of native bundles.
 *
 * `posthog-react-native`'s barrel eagerly `require()`s surveys, PostHogProvider,
 * PostHogErrorBoundary, PostHogMaskView and five React hooks. This app uses one
 * symbol — the `PostHog` class — behind a five-method interface in
 * `src/lib/telemetry.ts`. The `await import()` there looks like it defers the
 * cost and cannot: native has no code splitting, so a dynamic import is a
 * static edge with extra steps.
 *
 * metro.config.js therefore resolves the package to `dist/posthog-rn.js`, which
 * exports `PostHog` and pulls in none of that tree.
 *
 * The failure mode if this drifts is a screen that imports `usePostHog` or
 * `PostHogProvider` and gets `undefined` at runtime, so these tests fail the
 * build instead.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP_ROOT = join(__dirname, "..", "..");
const require_ = createRequire(import.meta.url);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.[jt]sx?$/u.test(entry)) out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

describe("PostHog is consumed through its core module only", () => {
  it("has exactly one importer, and it is the telemetry facade", () => {
    const importers = [
      ...sourceFiles(join(APP_ROOT, "src")),
      ...sourceFiles(join(APP_ROOT, "app")),
    ].filter((f) => {
      if (f.endsWith("posthogEntryPoint.test.ts")) return false;
      return /["']posthog-react-native["']/u.test(
        stripComments(readFileSync(f, "utf8")),
      );
    });
    // Vacuity floor and the constraint in one: the redirect is only safe while
    // the single consumer stays the one whose surface was checked.
    expect(importers.map((f) => f.replace(`${APP_ROOT}/`, ""))).toEqual([
      "src/lib/telemetry.ts",
    ]);
  });

  it("uses no API the core module does not carry", () => {
    const src = stripComments(
      readFileSync(join(APP_ROOT, "src/lib/telemetry.ts"), "utf8"),
    );
    // Everything below lives in the barrel's UI tree, not in posthog-rn.
    for (const banned of [
      "usePostHog",
      "useFeatureFlag",
      "useFeatureFlags",
      "useFeatureFlagResult",
      "useNavigationTracker",
      "PostHogProvider",
      "PostHogErrorBoundary",
      "PostHogMaskView",
    ]) {
      expect(src, `${banned} is not exported by dist/posthog-rn.js`).not.toContain(
        banned,
      );
    }
  });

  it("resolves to a module that really exports PostHog", () => {
    // The redirect rewrites the resolved entry's filename. If upstream moves
    // the class, the bundle would build and `new mod.PostHog()` would throw at
    // the first telemetry call.
    const entry = require_.resolve("posthog-react-native", {
      paths: [APP_ROOT],
    });
    const core = entry.replace(/index\.js$/u, "posthog-rn.js");
    expect(existsSync(core), `expected core module at ${core}`).toBe(true);
    expect(readFileSync(core, "utf8")).toContain("exports.PostHog");
  });

  it("keeps the redirect wired in metro.config.js", () => {
    const metro = stripComments(
      readFileSync(join(APP_ROOT, "metro.config.js"), "utf8"),
    );
    expect(metro).toContain("POSTHOG_PACKAGE");
    expect(metro).toMatch(/posthog-rn\.js/u);
  });
});
