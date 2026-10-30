import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * GUARD#11 — every @postwave package the app imports must be in Metro's
 * watchFolders.
 *
 * This list was hand-maintained and had drifted to 9 of the 12 packages the app
 * actually imports. The three that were missing all ship a prebuilt dist/, so they
 * resolved anyway — which is precisely why nobody noticed.
 *
 * The failure mode when it DOES bite is the worst kind: a package consumed as
 * live-linked TS source and left unwatched makes Metro fail with "Unable to
 * resolve …" at BOOT, as a red screen, pointing at the bundler rather than at the
 * package. That is a known, previously-shipped outage in this app —
 * `onboarding-schema` caused exactly it — and the fix each time was to remember a
 * list entry.
 *
 * So the requirement is derived from the source rather than remembered.
 */
const ROOT = join(__dirname, "..", "..");

/** Packages whose npm name does not match their directory. */
const DIRECTORY_FOR: Readonly<Record<string, string>> = {
  sdk: "sdk-ts",
};

function importedPackages(): string[] {
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
        sources.push(readFileSync(full, "utf8"));
      }
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "app"));
  const found = new Set<string>();
  for (const raw of sources) {
    // Strip comments first. This guard asks which packages the app IMPORTS,
    // and a package NAMED in prose is not an import: two mcp files document
    // their relationship to @postwave/mcp-server in a header comment and were
    // reported as unwatched imports of a package nothing actually imports.
    const text = raw
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    for (const match of text.matchAll(/@postwave\/([a-z-]+)/g)) {
      found.add(match[1] as string);
    }
  }
  return [...found].sort();
}


describe("metro watchFolders", () => {
  it("watches every @postwave package the app imports", () => {
    const config = readFileSync(join(ROOT, "metro.config.js"), "utf8");
    const missing = importedPackages().filter((name) => {
      const directory = DIRECTORY_FOR[name] ?? name;
      return !config.includes(`packages/${directory}"`);
    });
    expect(
      missing,
      `these packages are imported but not watched, so the day they stop shipping dist/ the bundle fails at boot: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("finds the packages it is meant to be checking", () => {
    // Guards the guard: a broken matcher would return [] and pass forever.
    const imported = importedPackages();
    expect(imported.length).toBeGreaterThanOrEqual(10);
    expect(imported).toContain("onboarding-schema");
    expect(imported).toContain("sdk");
  });
});
