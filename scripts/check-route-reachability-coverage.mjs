#!/usr/bin/env node
// Catch route-declaring packages that are mounted but invisible to the parity
// guard.
//
// THE BUG THIS EXISTS FOR, verbatim. `internal/activitycursor` declared
// `GET|PUT /api/v1/activity/last-viewed` and was mounted from main.go through
// the internal/server composition helper. It was absent from
// route-reachability.json.
//
// It served NOTHING. An earlier draft of this comment said it "served real
// traffic to web and desktop for months"; both halves were wrong, and a
// reviewer checked. The API refused to BOOT — `ValidateRouterExact` reported
// "GET /api/v1/activity/last-viewed has no exact route capability" — and with
// POSTWAVE_SKIP_ROUTE_AUTHZ_VALIDATION=1 set to get past that, the route
// returned 403 `route_authorization_unclassified` from routeauth.Middleware,
// which is exactly what docs/web-maturity-audit-2026-07-21/findings.json
// recorded at the time. It landed on main on 2026-07-20: 17 days, not months.
// The clients called it and got nothing back.
// `reachableRouteSourceFiles` scans a package only when main.go imports it
// DIRECTLY or the policy names it, and main.go imported the HELPER, not the
// package — so the cursor's routes were in neither the gateway inventory nor
// the spec. check-route-parity.mjs reported "OK, all gateway routes classified"
// while two live routes sat outside the contract entirely.
//
// That fail-closed rule is right for what it guards: an unmounted handler file
// must never be claimed as a gateway route. But it fails OPEN in the other
// direction, and silently — the number in the success line just gets smaller,
// and nothing about a smaller number reads as a warning.
//
// So this walks the import graph the parity guard deliberately does not: every
// internal package reachable from an already-reachable source. If such a package
// declares absolute /api routes and the policy neither registers nor excludes
// it, that is a package whose routes are being served without review.
//
// IT WALKS THE FULL CLOSURE, NOT ONE HOP. One hop was the first version, and its
// stated defence — "a package reached only through an unregistered intermediary
// is not a finding yet, because the intermediary is one and will be reported" —
// is false whenever the intermediary declares no routes of its own. There are 25
// such packages in this tree today (internal/pagination, internal/httperror,
// internal/entitlement, ...). A route-declaring package imported by any of them
// was invisible, which is the original bug one hop further out. A reviewer
// reproduced it end to end.
//
// It does not auto-include anything. Auto-including would defeat the
// fail-closed design — an unfinished scaffold would start being advertised the
// moment a helper imported it. The demand is a DECISION: register it with the
// call chain that proves it is mounted, or exclude it with a reason.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import {
  directInternalImports,
  extractAbsoluteRoutes,
  maskGoNonCode,
  reachableRouteSourceFiles,
  routeReachabilityPolicyPath,
} from "./lib/route-reachability.mjs";

const INTERNAL_SOURCE_PREFIX = "apps/api/internal/";

/** The package directory a repo-relative Go file belongs to. */
export function packageOf(file) {
  const cut = file.lastIndexOf("/");
  return cut === -1 ? file : file.slice(0, cut);
}

function pathMatchesRoot(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Packages the policy already accounts for.
 *
 * A registration covers its subdirectories: `internal/sms` being registered
 * makes `internal/sms/inbound` reachable too, because the walker recurses. A
 * coverage check that ignored that would demand an entry per directory and be
 * abandoned within a week.
 */
export function coveredRoots(policy) {
  return [
    ...policy.additional_sources.map((entry) => entry.path),
    ...policy.excluded_sources.map((entry) => entry.path),
  ];
}

export function isCovered(pkg, roots) {
  return roots.some((root) => pathMatchesRoot(pkg, root));
}

function goFilesIn(dir, out) {
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    return out;
  }
  if (!stats.isDirectory()) {
    if (dir.endsWith(".go") && !dir.endsWith("_test.go")) out.push(dir);
    return out;
  }
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry === ".git" || entry === "vendor") {
      continue;
    }
    goFilesIn(join(dir, entry), out);
  }
  return out;
}

/**
 * Every package transitively reachable from the composition root that declares
 * /api routes and is accounted for by neither list.
 *
 * The closure is what makes the check honest. Stopping at one hop meant a
 * route-declaring package imported by a route-LESS intermediary was invisible
 * forever: the intermediary was never reported (it declares nothing), so the
 * frontier never advanced past it. `internal/pagination` and 24 others are
 * exactly that shape.
 *
 * Registered and excluded packages are still traversed. A package's entry says
 * "these routes are reviewed", not "stop looking here" — and an unreviewed
 * package hiding behind a reviewed one is the same bug wearing a badge.
 */
export function findUnregisteredRouteSources(repoRoot) {
  const root = resolve(repoRoot);
  const policy = JSON.parse(
    readFileSync(resolve(root, routeReachabilityPolicyPath), "utf8"),
  );
  const roots = coveredRoots(policy);
  const reachableFiles = reachableRouteSourceFiles(root);
  const reachablePackages = new Set(
    reachableFiles.map((file) =>
      packageOf(relative(root, file).split(sep).join("/")),
    ),
  );

  // Breadth-first over the internal import graph, starting from everything the
  // policy already reaches.
  const visited = new Set(reachablePackages);
  const candidates = new Set();
  const queue = [];
  const enqueue = (pkg) => {
    if (visited.has(pkg)) return;
    visited.add(pkg);
    queue.push(pkg);
  };
  for (const file of reachableFiles) {
    for (const imported of directInternalImports(readFileSync(file, "utf8"))) {
      enqueue(imported);
    }
  }
  while (queue.length > 0) {
    const pkg = queue.shift();
    if (!isCovered(pkg, roots)) candidates.add(pkg);
    for (const file of goFilesIn(resolve(root, pkg), [])) {
      for (const imported of directInternalImports(readFileSync(file, "utf8"))) {
        enqueue(imported);
      }
    }
  }

  const findings = [];
  for (const pkg of [...candidates].sort()) {
    const routes = new Set();
    for (const file of goFilesIn(resolve(root, pkg), [])) {
      const raw = readFileSync(file, "utf8");
      for (const route of extractAbsoluteRoutes(raw, maskGoNonCode(raw))) {
        routes.add(route);
      }
    }
    if (routes.size > 0) findings.push({ package: pkg, routes: [...routes].sort() });
  }
  return findings;
}

// ---------------------------------------------------------------------------

function selfTest() {
  const failures = [];
  const check = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) failures.push(`${name}: expected ${e}, got ${a}`);
  };

  check("packageOf strips the file", packageOf("apps/api/internal/x/y.go"), "apps/api/internal/x");
  check("packageOf on a bare name", packageOf("main.go"), "main.go");

  const roots = ["apps/api/internal/sms", "apps/api/internal/aeo"];
  check("exact root is covered", isCovered("apps/api/internal/sms", roots), true);
  check("subpackage is covered", isCovered("apps/api/internal/sms/inbound", roots), true);
  check("sibling with a shared prefix is NOT covered", isCovered("apps/api/internal/smsx", roots), false);
  check("unrelated package is not covered", isCovered("apps/api/internal/tags", roots), false);

  check(
    "coveredRoots merges registered and excluded",
    coveredRoots({
      additional_sources: [{ path: "a" }],
      excluded_sources: [{ path: "b" }],
    }),
    ["a", "b"],
  );

  // The masking contract this relies on: a route mentioned in a comment or a
  // string is not a declaration. Without this the guard would demand a policy
  // entry for a package whose only "route" is documentation.
  const commented = `// r.Get("/api/v1/ghost", h)\nfunc f() {}`;
  check(
    "a commented-out route is not a declaration",
    [...extractAbsoluteRoutes(commented, maskGoNonCode(commented))],
    [],
  );
  const real = `func f(r chi.Router) { r.Get("/api/v1/real", h) }`;
  check(
    "a live route is a declaration",
    [...extractAbsoluteRoutes(real, maskGoNonCode(real))],
    ["GET /api/v1/real"],
  );

  // The regression itself: before its policy entry landed, activitycursor was
  // exactly this shape — imported by a reachable helper, declaring /api routes,
  // named nowhere in the policy.
  check(
    "an imported, route-declaring, unlisted package is a finding",
    isCovered("apps/api/internal/activitycursor", ["apps/api/internal/userprefs"]),
    false,
  );

  if (failures.length > 0) {
    console.error("check-route-reachability-coverage self-test FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`check-route-reachability-coverage self-test OK (10 assertions)`);
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const repoRoot = resolve(new URL("..", import.meta.url).pathname);
  const findings = findUnregisteredRouteSources(repoRoot);
  if (findings.length === 0) {
    console.log(
      "Route reachability coverage OK: every route-declaring package imported by " +
        "a reachable source is registered or excluded.",
    );
    return;
  }
  console.error("Route reachability coverage FAILED.\n");
  console.error(
    "These packages declare /api routes and are imported by a source the API\n" +
      "composition already reaches, but appear in neither additional_sources nor\n" +
      `excluded_sources of ${routeReachabilityPolicyPath}. Their routes are\n` +
      "therefore absent from the gateway inventory, which means check-route-parity\n" +
      "cannot see them and they carry no release classification.\n",
  );
  for (const finding of findings) {
    console.error(`  ${finding.package}`);
    for (const route of finding.routes) console.error(`      ${route}`);
  }
  console.error(
    "\nDecide, do not auto-include: add an additional_sources entry naming the\n" +
      "call chain that proves the mount, or an excluded_sources entry saying why\n" +
      "the package must not be served.",
  );
  process.exit(1);
}

main();
