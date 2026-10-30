#!/usr/bin/env node
//
// scripts/check-route-parity.mjs
//
// Compares the reachable Go gateway chi routes against openapi.yaml. Route
// source reachability is fail-closed by packages/openapi/route-reachability.json;
// an unmounted internal handlers file is not a gateway merely because it exists.
// Routes that are intentionally outside the public SDK/OpenAPI contract must
// be classified in packages/openapi/route-contracts.json. This keeps internal,
// public-token, embed, compat, and health routes explicit instead of hidden in
// a loose allowlist.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { gatewayRouteInventory } from "./lib/route-reachability.mjs";
import {
  contractForRoute,
  loadRouteContracts,
  validateGatewayOnlyContracts,
} from "./lib/route-contracts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const SPEC_PATH = resolve(repoRoot, "packages/openapi/openapi.yaml");
const ROUTE_CONTRACTS_PATH = resolve(
  repoRoot,
  "packages/openapi/route-contracts.json",
);
const routeContracts = loadRouteContracts(ROUTE_CONTRACTS_PATH);
const KNOWN_SPEC_ONLY = new Set([]);
const verbose = process.argv.includes("--verbose");
const exposureFilter = process.argv
  .find((arg) => arg.startsWith("--exposure="))
  ?.slice("--exposure=".length);

// Exact-route contract rules for endpoints the gateway does not serve.
//
// A `route:` rule is a REVIEWED exposure decision for one specific endpoint.
// When that endpoint does not exist the rule classifies nothing — which is
// harmless right up until somebody mounts that path, at which point the new
// route silently inherits a classification made in another context and never
// re-reviewed, and passes this very check without anyone looking at it. The
// step-up policy had the mirror-image defect: it named four routes that did not
// exist and therefore protected nothing.
//
// ENUMERATED, NOT COUNTED, and the list may only SHRINK. Deleting these rules
// outright would be wrong — several are for integrations that are planned — but
// a NEW one must fail, because the moment it is written down it is a decision
// nobody will revisit.
const KNOWN_UNSERVED_CONTRACT_ROUTES = new Set([
  "GET /api/v1/inbox-reality",
  "GET /api/v1/automations/{id}/events",
  "GET /api/v1/crm/dynamics365/oauth/availability",
  "GET /api/v1/crm/dynamics365/oauth/callback",
  "GET /api/v1/crm/dynamics365/oauth/start",
  "GET /api/v1/crm/gohighlevel/oauth/availability",
  "GET /api/v1/crm/gohighlevel/oauth/callback",
  "GET /api/v1/crm/gohighlevel/oauth/start",
  "GET /api/v1/crm/hubspot/oauth/availability",
  "GET /api/v1/crm/hubspot/oauth/callback",
  "GET /api/v1/crm/hubspot/oauth/start",
  "GET /api/v1/crm/keap/oauth/availability",
  "GET /api/v1/crm/keap/oauth/callback",
  "GET /api/v1/crm/keap/oauth/start",
  "GET /api/v1/crm/pipedrive/oauth/availability",
  "GET /api/v1/crm/pipedrive/oauth/callback",
  "GET /api/v1/crm/pipedrive/oauth/start",
  "GET /api/v1/crm/salesforce/oauth/availability",
  "GET /api/v1/crm/salesforce/oauth/callback",
  "GET /api/v1/crm/salesforce/oauth/start",
  "GET /api/v1/crm/zoho/oauth/availability",
  "GET /api/v1/crm/zoho/oauth/callback",
  "GET /api/v1/crm/zoho/oauth/start",
]);

function checkContractRoutesAreServed() {
  const unserved = [];
  const resurrected = [];
  for (const rule of routeContracts.rules) {
    if (!rule.route) continue;
    if (gateway.has(rule.route)) {
      if (KNOWN_UNSERVED_CONTRACT_ROUTES.has(rule.route)) resurrected.push(rule.route);
      continue;
    }
    if (!KNOWN_UNSERVED_CONTRACT_ROUTES.has(rule.route)) unserved.push(rule.route);
  }
  if (resurrected.length > 0) {
    console.error(
      "These contract routes are now served and must be removed from " +
        "KNOWN_UNSERVED_CONTRACT_ROUTES, so the list keeps meaning what it says. " +
        "Their exposure classification is now live and should be re-read before " +
        "you strike them off:\n  - " + resurrected.sort().join("\n  - "),
    );
    process.exit(2);
  }
  if (unserved.length > 0) {
    console.error(
      `route-contracts.json classifies ${unserved.length} endpoint(s) the gateway ` +
        "does not serve. A reviewed exposure decision for a route that does not " +
        "exist classifies nothing today and silently pre-approves whatever is " +
        "mounted at that path tomorrow:\n  - " + unserved.sort().join("\n  - "),
    );
    process.exit(2);
  }
}

function classifyGatewayOnly(route) {
  return contractForRoute(route, routeContracts);
}

function normalize(p) {
  let out = p.replace(/\/\*$/, "/{rest}");
  // Strip chi's inline regex constraint on a path param so a gateway
  // `{file_key:.+}` matches the spec's `{file_key}` (otherwise the same
  // route shows up as both gateway-only AND spec-only).
  out = out.replace(/\{([^}:]+):[^}]+\}/g, "{$1}");
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function extractSpecRoutes() {
  const routes = new Set();
  const yaml = readFileSync(SPEC_PATH, "utf8");
  const lines = yaml.split(/\r?\n/u);
  let inPaths = false;
  let pathsIndent = -1;
  let currentPath = null;
  let pathIndent = -1;

  for (const raw of lines) {
    const trimmed = raw.replace(/\t/g, "    ");
    const indent = trimmed.match(/^(\s*)/)?.[1].length ?? 0;
    const text = trimmed.trim();

    if (!inPaths) {
      if (text === "paths:") {
        inPaths = true;
        pathsIndent = indent;
      }
      continue;
    }
    if (text !== "" && indent <= pathsIndent && !/^paths:/u.test(text)) {
      break;
    }
    if (
      indent === pathsIndent + 2 &&
      text.startsWith("/") &&
      text.endsWith(":")
    ) {
      currentPath = text.slice(0, -1);
      pathIndent = indent;
      continue;
    }
    if (
      currentPath &&
      indent === pathIndent + 2 &&
      /^(get|post|patch|put|delete|head|options):\s*$/iu.test(text)
    ) {
      const verb = text.replace(":", "").toUpperCase();
      routes.add(`${verb} ${normalize(currentPath)}`);
    }
  }
  return routes;
}

const gatewayInventory = gatewayRouteInventory(repoRoot);
const gateway = gatewayInventory.routes;
const migrationSidecar = gatewayInventory.migrationSidecar;
const spec = extractSpecRoutes();

if (gateway.size === 0) {
  console.error("ERROR: zero gateway routes parsed; the regex may be broken.");
  process.exit(2);
}
if (spec.size === 0) {
  console.error(
    "ERROR: zero spec routes parsed; the YAML walker may be broken.",
  );
  process.exit(2);
}

function pathOf(entry) {
  return entry.split(" ").slice(1).join(" ");
}
checkContractRoutesAreServed();
const specPaths = new Set([...spec].map(pathOf));
const gatewayPaths = new Set([...gateway].map(pathOf));
const wildcardPrefixes = [...gatewayPaths]
  .filter((p) => p.endsWith("/{rest}"))
  .map((p) => p.slice(0, -"/{rest}".length));

function isCoveredByWildcard(p) {
  return wildcardPrefixes.some(
    (prefix) => p === prefix || p.startsWith(prefix + "/"),
  );
}

const rawGatewayOnly = [...gateway]
  .filter((e) => {
    if (spec.has(e)) return false;
    if (e.startsWith("ANY ") && specPaths.has(pathOf(e))) return false;
    return true;
  })
  .filter((e) => !e.endsWith("/{rest}"))
  .sort();

try {
  validateGatewayOnlyContracts({
    contracts: routeContracts,
    gatewayRoutes: gateway,
    gatewayOnlyRoutes: rawGatewayOnly,
  });
} catch (error) {
  console.error(`Route-contract exactness FAILED:\n${error.message}`);
  process.exit(2);
}

const classifiedGatewayOnly = [];
const unclassifiedGatewayOnly = [];
for (const route of rawGatewayOnly) {
  const rule = classifyGatewayOnly(route);
  if (rule) classifiedGatewayOnly.push({ route, rule });
  else unclassifiedGatewayOnly.push(route);
}

const specOnly = [...spec]
  .filter((e) => {
    if (gateway.has(e)) return false;
    if (gatewayPaths.has(pathOf(e))) return false;
    if (isCoveredByWildcard(pathOf(e))) return false;
    return true;
  })
  .filter((e) => !KNOWN_SPEC_ONLY.has(e))
  .sort();

const migrationSpecOnly = [...spec]
  .filter((e) => pathOf(e).startsWith("/api/v1/migrations"))
  .filter((e) => !migrationSidecar.has(e))
  .filter((e) => !classifyGatewayOnly(e))
  .sort();
for (const route of migrationSpecOnly) {
  if (!specOnly.includes(route)) specOnly.push(route);
}
specOnly.sort();

if (unclassifiedGatewayOnly.length === 0 && specOnly.length === 0) {
  const counts = new Map();
  for (const { rule } of classifiedGatewayOnly) {
    counts.set(rule.exposure, (counts.get(rule.exposure) ?? 0) + 1);
  }
  const classified = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  console.log(
    `Route parity OK: ${gateway.size} gateway routes, ${spec.size} spec routes ` +
      `(${classifiedGatewayOnly.length} gateway-only routes classified` +
      `${classified ? ` — ${classified}` : ""}; ${KNOWN_SPEC_ONLY.size} spec-only; ` +
      `${migrationSidecar.size} migration sidecar routes checked).`,
  );
  if (verbose && classifiedGatewayOnly.length > 0) {
    console.log("\nClassified gateway-only routes:");
    for (const { route, rule } of classifiedGatewayOnly) {
      if (exposureFilter && rule.exposure !== exposureFilter) continue;
      console.log(`  ${route} [${rule.exposure}] — ${rule.reason}`);
    }
  }
  process.exit(0);
}

console.error("Route parity FAILED — contract drift detected.\n");
console.error("Gateway:  apps/api/ (chi handlers)");
console.error("Spec:     packages/openapi/openapi.yaml");
console.error("Contracts: packages/openapi/route-contracts.json\n");

if (unclassifiedGatewayOnly.length > 0) {
  console.error(
    "In gateway, missing from spec and missing a route-contract classification:",
  );
  for (const e of unclassifiedGatewayOnly) console.error("  + " + e);
  console.error("");
}
if (specOnly.length > 0) {
  console.error(
    "In spec, missing from gateway (SDK calls will 404 at runtime):",
  );
  for (const e of specOnly) console.error("  - " + e);
  console.error("");
}
console.error(
  "Reconcile by either (a) adding/removing the OpenAPI route, " +
    "(b) adding/removing the gateway handler, or (c) adding a deliberate " +
    "classification to packages/openapi/route-contracts.json with exposure + reason.",
);
process.exit(1);
