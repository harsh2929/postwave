/**
 * Every Expo Router module must be loaded by at least one native test.
 *
 * The detailed route suites are intentionally distributed by product surface,
 * while routes.native.test.tsx is a cheap smoke subset. Both are manual import
 * lists. Without this filesystem-to-import contract, adding a route can leave
 * it absent from every native test while all existing lists remain green.
 *
 * Direct native-test imports are the boundary on purpose: importing a module
 * catches native dependency/load failures, and every renderable route is then
 * exercised either by the smoke suite or its focused screen suite. Expo's
 * `+native-intent` convention has no component to render, but its native test
 * imports and invokes the exported redirect hook.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const MOBILE_ROOT = resolve(__dirname, "../..");
const APP_DIR = join(MOBILE_ROOT, "app");
const NATIVE_TEST_DIR = join(MOBILE_ROOT, "__tests__");
const TEST_IMPORT =
  /(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/gu;

function filesBelow(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...filesBelow(full));
    else files.push(full);
  }
  return files;
}

function routeCandidate(testFile: string, specifier: string): string[] {
  let base: string;
  if (specifier.startsWith("@app/")) {
    base = join(APP_DIR, specifier.slice("@app/".length));
  } else if (specifier.startsWith(".")) {
    base = resolve(dirname(testFile), specifier);
  } else {
    return [];
  }
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ].map(normalize);
}

describe("native route-module coverage", () => {
  const routeFiles = filesBelow(APP_DIR)
    .filter((file) => /\.(?:ts|tsx)$/u.test(file))
    .map(normalize)
    .sort();
  const routeSet = new Set(routeFiles);
  const covered = new Set<string>();

  for (const testFile of filesBelow(NATIVE_TEST_DIR).filter((file) =>
    /\.native\.test\.(?:ts|tsx)$/u.test(file),
  )) {
    const source = readFileSync(testFile, "utf8");
    for (const match of source.matchAll(TEST_IMPORT)) {
      for (const candidate of routeCandidate(testFile, match[1] ?? "")) {
        if (routeSet.has(candidate)) covered.add(candidate);
      }
    }
  }

  it("finds the complete route tree and native test catalogue", () => {
    expect(routeFiles.length).toBeGreaterThan(100);
    expect(covered.size).toBeGreaterThan(100);
  });

  it("loads every route and layout module from a native test", () => {
    const missing = routeFiles
      .filter((file) => !covered.has(file))
      .map((file) => relative(MOBILE_ROOT, file).replaceAll("\\", "/"));
    expect(missing).toEqual([]);
  });
});
