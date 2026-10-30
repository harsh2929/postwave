// SPDX-License-Identifier: AGPL-3.0-only
//
// next.config's outputFileTracingExcludes, replayed through the matcher Next
// itself uses (next/dist/build/collect-build-traces): picomatch with
// `contains: true`, which matches any substring of a path. Under one "*" key
// the old globs dropped files the server loads at runtime — lodash.map,
// core-js's es.map.js, every dependency's scripts/ directory — from the
// standalone image. These tests hold the runtime tree and the forbidden tree
// apart, over the real dependency set installed in this checkout.
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { outputFileTracingExcludes } from "../../scripts/lib/output-file-tracing.mjs";

type Matcher = (value: string) => boolean;
type Picomatch = (
  glob: string | string[],
  options?: { contains?: boolean; dot?: boolean },
) => Matcher;
const picomatch = createRequire(import.meta.url)(
  "next/dist/compiled/picomatch",
) as Picomatch;

const WEB = path.resolve(__dirname, "../..");
const ROOT = path.resolve(WEB, "../..");
const MATCH = { contains: true, dot: true };
const entries = Object.entries(outputFileTracingExcludes);

/** The server trace and every route's dependency walk: root-relative paths. */
const serverGlobs = entries
  .filter(([key]) => picomatch(key)("next-server"))
  .flatMap(([, globList]) => globList);
const serverMatcher = picomatch(serverGlobs, MATCH);
function droppedFromServer(rootRelative: string): boolean {
  return serverGlobs.length > 0 && serverMatcher(rootRelative);
}

/** One route's trace: patterns resolved against apps/web, absolute paths. */
const routeMatchers = new Map<string, Matcher | null>();
function droppedFromRoute(route: string, absolute: string): boolean {
  if (!routeMatchers.has(route)) {
    const globs = entries
      .filter(([key]) => picomatch(key, MATCH)(route))
      .flatMap(([, globList]) => globList.map((glob) => path.join(WEB, glob)));
    routeMatchers.set(route, globs.length > 0 ? picomatch(globs, MATCH) : null);
  }
  return routeMatchers.get(route)?.(absolute) ?? false;
}

/** Build tooling excluded on purpose, by package name. */
const BUILD_ONLY =
  /^(?:@swc\/core.*|@esbuild\/.+|esbuild|webpack|babel-plugin-react-compiler|@img\/sharp-libvips-linux-.+|@img\/sharp-linux-.+|eslint|prettier|turbo|typescript|vitest)$/;

const ROUTES = ["/", "/docs/api/[endpoint]", "/app/campaigns/[id]", "/api/csp-report"];

describe("outputFileTracingExcludes", () => {
  it("drops no installed dependency but the build-only tooling", () => {
    // Every package in the pnpm store, as the server trace sees its files.
    const store = readdirSync(path.join(ROOT, "node_modules/.pnpm")).filter(
      (entry) => entry.includes("@") && !entry.startsWith("."),
    );
    expect(store.length).toBeGreaterThan(500); // guard the guard
    const wrong: string[] = [];
    for (const entry of store) {
      const at = entry.indexOf("@", entry.startsWith("@") ? 1 : 0);
      const name = entry.slice(0, at).replace("+", "/");
      for (const file of ["index.js", "scripts/postinstall.js", "dist/index.map.js"]) {
        const relative = `node_modules/.pnpm/${entry}/node_modules/${name}/${file}`;
        if (droppedFromServer(relative) !== BUILD_ONLY.test(name)) wrong.push(relative);
        for (const route of ROUTES) {
          if (droppedFromRoute(route, path.join(ROOT, relative))) wrong.push(`${route}: ${relative}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("keeps the runtime files the unanchored globs used to drop", () => {
    for (const relative of [
      "node_modules/.pnpm/lodash.map@4.6.0/node_modules/lodash.map/index.js",
      "node_modules/.pnpm/core-js@3.41.0/node_modules/core-js/modules/es.map.js",
      "node_modules/.pnpm/ts-interface-checker@0.1.13/node_modules/ts-interface-checker/dist/index.js",
      "node_modules/.pnpm/sharp@0.34.3/node_modules/sharp/lib/index.js",
      "node_modules/.pnpm/@img+sharp-linuxmusl-arm64@0.34.3/node_modules/@img/sharp-linuxmusl-arm64/lib/sharp-linuxmusl-arm64.node",
      "apps/web/.next/server/app/page.js",
      "apps/web/.next/server/chunks/4521.js",
      "apps/web/package.json",
      "packages/design-tokens/dist/index.js",
      "packages/design-tokens/package.json",
    ]) {
      expect(droppedFromServer(relative), relative).toBe(false);
      for (const route of ROUTES) {
        expect(droppedFromRoute(route, path.join(ROOT, relative)), `${route}: ${relative}`).toBe(false);
      }
    }
  });

  it("drops what verify-web-image.sh forbids, from the server and from every route", () => {
    for (const relative of [
      "apps/web/scripts/lib/sentry-dsn-origin.mjs",
      "apps/web/src/app/(docs)/docs/changelog/page.tsx",
      "apps/web/src/lib/api.ts",
      "apps/web/next-env.d.ts",
      "apps/web/.next/types/app/page.ts",
      "packages/sdk-ts/src/index.ts",
      "packages/mcp-server/dist/index.js",
      "packages/mcp-server/package.json",
    ]) {
      expect(droppedFromServer(relative), relative).toBe(true);
      for (const route of ROUTES) {
        expect(droppedFromRoute(route, path.join(ROOT, relative)), `${route}: ${relative}`).toBe(true);
      }
    }
    // Route traces also carry the workspace packages' type declarations.
    for (const route of ROUTES) {
      expect(
        droppedFromRoute(route, path.join(ROOT, "packages/design-tokens/dist/index.d.ts")),
        route,
      ).toBe(true);
    }
  });

  it("drops every TypeScript source in the web app and the packages, as the image gate does", () => {
    // verify-web-image.sh refuses any app/(apps|packages)/**/*.ts(x) in the
    // image. Listing shapes by hand let packages/*/tests through once, so walk
    // the real trees instead: whatever TypeScript a package grows next is held
    // to the same rule without anyone remembering to add it here.
    const SKIP = new Set(["node_modules", "dist", ".next", ".turbo", "coverage"]);
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIP.has(entry.name)) walk(path.join(dir, entry.name));
        } else if (/\.tsx?$/.test(entry.name)) {
          sources.push(path.relative(ROOT, path.join(dir, entry.name)));
        }
      }
    };
    walk(WEB);
    for (const pkg of readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })) {
      if (pkg.isDirectory()) walk(path.join(ROOT, "packages", pkg.name));
    }
    // Vacuity floor: a broken walk would make the rule below pass for free.
    expect(sources.length).toBeGreaterThan(2000);
    expect(sources.some((f) => /^packages\/[^/]+\/tests\//.test(f))).toBe(true);

    const kept: string[] = [];
    for (const relative of sources) {
      if (!droppedFromServer(relative)) kept.push(`server: ${relative}`);
      for (const route of ROUTES) {
        if (!droppedFromRoute(route, path.join(ROOT, relative))) kept.push(`${route}: ${relative}`);
      }
    }
    expect(kept.slice(0, 20)).toEqual([]);
  });

  it("is the policy next.config.mjs hands to Next, after its plugin wrappers", async () => {
    // The assertions above replay the helper module; this pins that the
    // config Next loads uses it. Reverting next.config.mjs to its own inline
    // globs (the unanchored ones) fails here.
    const configUrl = new URL("../../next.config.mjs", import.meta.url).href;
    const loaded = (await import(/* @vite-ignore */ configUrl)) as {
      default: { outputFileTracingExcludes?: unknown };
    };
    expect(loaded.default.outputFileTracingExcludes).toEqual(outputFileTracingExcludes);
  });
});
