// SPDX-License-Identifier: AGPL-3.0-only
//
// Audits every production `api.get/post/postRaw/put/putRaw/patch/delete` call
// with the same TypeScript project and path aliases the web app compiles. Path
// expressions must reduce to a finite, structurally reviewable set; unresolved
// helpers or whole-path strings fail closed. The mounted side comes from the
// repository's authoritative composition-aware gateway inventory, not a second
// regex approximation of Go route declarations.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  auditApiClientCalls,
  compileGatewayRouteMatcher,
  formatIssues,
} from "./helpers/client-route-audit";

interface GatewayInventoryModule {
  gatewayRouteInventory(repoRoot: string): { routes: Set<string> };
}

const WEB_ROOT = process.cwd();
const REPO_ROOT = resolve(WEB_ROOT, "../..");
const SOURCE_ROOT = resolve(WEB_ROOT, "src");
const TSCONFIG = resolve(WEB_ROOT, "tsconfig.json");

function webProgram(): ts.Program {
  const config = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
  if (config.error) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext([config.error], {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => WEB_ROOT,
        getNewLine: () => "\n",
      }),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    WEB_ROOT,
    undefined,
    TSCONFIG,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => WEB_ROOT,
        getNewLine: () => "\n",
      }),
    );
  }
  return ts.createProgram(parsed.fileNames, parsed.options);
}

const reachabilityURL = pathToFileURL(
  resolve(REPO_ROOT, "scripts/lib/route-reachability.mjs"),
).href;
const reachability = (await import(
  /* @vite-ignore */ reachabilityURL
)) as GatewayInventoryModule;
const gatewayRoutes = reachability.gatewayRouteInventory(REPO_ROOT).routes;
const audit = auditApiClientCalls(webProgram(), SOURCE_ROOT, {
  apiModulePath: resolve(SOURCE_ROOT, "lib/api.ts"),
});
const matcher = compileGatewayRouteMatcher(gatewayRoutes);

const unmounted = audit.calls.flatMap((call) =>
  call.paths.flatMap((path) => {
    const match = matcher.match(call.method, path);
    return match.mounted
      ? []
      : [
          `${call.file}:${call.line} ${call.method} ${path.value} ` +
            `(from ${call.expression}; nearest=${match.route ?? "none"})`,
        ];
  }),
);
const resolvedPaths = audit.calls.reduce(
  (count, call) => count + call.paths.length,
  0,
);

console.info(
  `client-route audit: calls=${audit.calls.length} resolved_paths=${resolvedPaths} ` +
    `unresolved=${audit.unresolved.length} unmounted=${unmounted.length} ` +
    `unsafe=${audit.unsafeDynamicSegments.length} gateway=${gatewayRoutes.size}`,
);

describe("web API client calls reach mounted gateway routes", () => {
  it("loads the full TypeScript call surface and authoritative gateway", () => {
    expect(gatewayRoutes.size).toBeGreaterThan(2_000);
    expect(audit.calls.length).toBeGreaterThan(1_000);
    expect(resolvedPaths).toBeGreaterThan(audit.calls.length);
  });

  it("fails closed when a pathname expression cannot be resolved", () => {
    expect(formatIssues(audit.unresolved)).toEqual([]);
  });

  it("structurally matches every finite pathname to the mounted method", () => {
    expect(unmounted.sort()).toEqual([]);
  });

  it("allows no unreviewed raw string pathname segment", () => {
    expect(formatIssues(audit.unsafeDynamicSegments)).toEqual([]);
  });
});
