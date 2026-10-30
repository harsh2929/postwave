import { readFileSync } from "node:fs";

const PROVISIONAL_EXPOSURE = /pending|uncodified|triage/iu;

export function normalizeContractRoute(route) {
  if (typeof route !== "string") return null;
  const trimmed = route.trim();
  const separator = trimmed.indexOf(" ");
  if (separator <= 0) return null;
  const method = trimmed.slice(0, separator);
  let path = trimmed.slice(separator + 1);
  if (!/^[A-Z]+$/u.test(method) || !path.startsWith("/")) return null;
  path = path.replace(/\/\*$/u, "/{rest}");
  path = path.replace(/\{([^}:]+):[^}]+\}/gu, "{$1}");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `${method} ${path}`;
}

function assertCanonicalRoute(route, label) {
  const normalized = normalizeContractRoute(route);
  if (normalized == null || normalized !== route) {
    throw new Error(`${label} must be a canonical METHOD /path route key`);
  }
}

export function compileRouteContracts(document, source = "route-contracts.json") {
  if (!document || !Array.isArray(document.rules)) {
    throw new Error(`${source} must contain rules[]`);
  }

  const rules = [];
  const exact = new Map();
  const memberships = new Map();

  for (const [index, rawRule] of document.rules.entries()) {
    const label = `${source} rule ${index}`;
    const hasRoute =
      typeof rawRule.route === "string" && rawRule.route.trim() !== "";
    const hasPattern =
      typeof rawRule.pattern === "string" && rawRule.pattern.trim() !== "";
    if (hasRoute === hasPattern) {
      throw new Error(`${label} must contain exactly one of route or pattern`);
    }
    if (
      typeof rawRule.reason !== "string" ||
      rawRule.reason.trim() === ""
    ) {
      throw new Error(`${label} is missing reason`);
    }
    if (
      typeof rawRule.exposure !== "string" ||
      rawRule.exposure.trim() === ""
    ) {
      throw new Error(`${label} is missing exposure`);
    }
    if (PROVISIONAL_EXPOSURE.test(rawRule.exposure)) {
      throw new Error(
        `${label} (${rawRule.route ?? rawRule.pattern}) still has provisional exposure ${JSON.stringify(rawRule.exposure)}`,
      );
    }

    if (hasRoute) {
      const route = rawRule.route.trim();
      assertCanonicalRoute(route, `${label} route`);
      if (rawRule.gateway_only_routes !== undefined) {
        throw new Error(
          `${label} exact route must not define gateway_only_routes`,
        );
      }
      if (exact.has(route)) {
        throw new Error(`${label} duplicates exact route ${route}`);
      }
      const rule = { ...rawRule, route };
      exact.set(route, rule);
      rules.push(rule);
      continue;
    }

    const pattern = rawRule.pattern.trim();
    let regex;
    try {
      regex = new RegExp(pattern, "u");
    } catch (error) {
      throw new Error(`${label} has invalid pattern ${pattern}`, {
        cause: error,
      });
    }
    const listed = rawRule.gateway_only_routes ?? [];
    if (!Array.isArray(listed)) {
      throw new Error(`${label} gateway_only_routes must be an array`);
    }
    // Route keys are ASCII. Code-unit order is deterministic across machines,
    // unlike locale-aware collation, and matches every other checked-in route
    // inventory in this repository.
    const sorted = [...listed].sort();
    if (listed.some((route, membershipIndex) => route !== sorted[membershipIndex])) {
      throw new Error(`${label} gateway_only_routes must be sorted`);
    }

    const rule = { ...rawRule, pattern, regex };
    for (const [membershipIndex, route] of listed.entries()) {
      if (typeof route !== "string") {
        throw new Error(
          `${label} gateway_only_routes[${membershipIndex}] must be a string`,
        );
      }
      assertCanonicalRoute(
        route,
        `${label} gateway_only_routes[${membershipIndex}]`,
      );
      regex.lastIndex = 0;
      if (!regex.test(route)) {
        throw new Error(
          `${label} gateway_only_routes entry ${route} does not match ${pattern}`,
        );
      }
      if (memberships.has(route)) {
        throw new Error(
          `${label} gateway_only_routes duplicates membership ${route}`,
        );
      }
      memberships.set(route, rule);
    }
    rules.push(rule);
  }

  for (const route of memberships.keys()) {
    if (exact.has(route)) {
      throw new Error(
        `${source} gateway_only_routes entry ${route} is shadowed by an exact route rule`,
      );
    }
  }

  return { rules, exact, memberships };
}

export function loadRouteContracts(path) {
  const rawText = readFileSync(path, "utf8");
  const compiled = compileRouteContracts(JSON.parse(rawText), path);
  return { ...compiled, rawText };
}

export function contractForRoute(route, contracts) {
  return contracts.exact.get(route) ?? contracts.memberships.get(route) ?? null;
}

export function validateGatewayOnlyContracts({
  contracts,
  gatewayRoutes,
  gatewayOnlyRoutes,
  requireExactAny = true,
}) {
  const gateway = new Set(gatewayRoutes);
  const gatewayOnly = new Set(gatewayOnlyRoutes);
  const errors = [];

  for (const route of contracts.memberships.keys()) {
    if (!gateway.has(route)) {
      errors.push(`stale gateway_only_routes entry is not mounted: ${route}`);
    } else if (!gatewayOnly.has(route)) {
      errors.push(
        `stale gateway_only_routes entry is now documented or otherwise outside the gateway-only inventory: ${route}`,
      );
    }
  }

  for (const route of gatewayOnly) {
    if (contractForRoute(route, contracts) == null) {
      errors.push(
        `gateway-only route lacks an exact rule or reviewed pattern membership: ${route}`,
      );
    }
  }

  if (requireExactAny) {
    for (const route of gateway) {
      if (route.startsWith("ANY ") && !contracts.exact.has(route)) {
        errors.push(`method-agnostic route requires an exact contract: ${route}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.sort().join("\n"));
  }
}
