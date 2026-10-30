#!/usr/bin/env node
//
// Generate the API gateway's fail-closed authorization manifest.
//
// Canonical inputs:
//   - packages/openapi/openapi.yaml (public operations and explicit security)
//   - packages/openapi/route-contracts.json (reviewed gateway-only exposure)
//   - packages/openapi/route-reachability.json (what code is actually mounted)
//
// The generated JSON is embedded by apps/api/internal/routeauth. Keep policy
// decisions here, not in the Go middleware: generation makes every reachable
// method/template explicit and --check turns route drift into a CI failure.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gatewayRouteInventory } from "./lib/route-reachability.mjs";
import {
  contractForRoute,
  loadRouteContracts,
  validateGatewayOnlyContracts,
} from "./lib/route-contracts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const specPath = resolve(repoRoot, "packages/openapi/openapi.yaml");
const contractsPath = resolve(
  repoRoot,
  "packages/openapi/route-contracts.json",
);
const reachabilityPath = resolve(
  repoRoot,
  "packages/openapi/route-reachability.json",
);
const outputPath = resolve(
  repoRoot,
  "apps/api/internal/routeauth/manifest.json",
);
const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);
const READ_METHODS = new Set(["GET", "HEAD"]);
const VALID_SCOPES = new Set([
  "read:subscribers",
  "write:subscribers",
  "read:campaigns",
  "write:campaigns",
  "send:transactional",
  "read:reports",
  "admin",
  "audit:read",
  "audit:read_pii",
  "audit:read_all_tenants",
  "audit:configure_sinks",
  "audit:configure_retention",
  "audit:execute_actions",
  "mcp",
]);
const VALID_AUTH_METHODS = new Set(["session", "api_key"]);
const VALID_ROLES = new Set(["viewer", "editor", "admin", "owner"]);

// These families are the established editor surface. The fallback for a
// legacy mutation that has neither an OpenAPI scope nor one of these reviewed
// family mappings is admin, never editor. That is deliberately fail-closed.
const SUBSCRIBER_FAMILY = [
  /^\/api\/v1\/(?:subscribers|lists|segments|tags|suppressions)(?:\/|$)/u,
  /^\/api\/v1\/push\/devices$/u,
  /^\/api\/v1\/(?:merge-fields|preset-segments|subscriber-imports|tag-taxonomy)(?:\/|$)/u,
  /^\/api\/v1\/(?:topics|lifecycle|engagement-scores)(?:\/|$)/u,
  /^\/api\/v1\/sms\/lists(?:\/|$)/u,
];
const CAMPAIGN_FAMILY = [
  /^\/api\/v1\/(?:campaigns|campaign-templates|blocks|automations|flow-builder)(?:\/|$)/u,
  /^\/api\/v1\/(?:goals|utm-templates|send-time-opt|send-window)(?:\/|$)/u,
  /^\/api\/v1\/voice\/(?:profile|sequences|sources|templates)(?:\/|$)/u,
  /^\/api\/v1\/(?:omnichannel\/campaigns|sms\/(?:campaigns|broadcasts))(?:\/|$)/u,
];
const REPORT_FAMILY = [
  /^\/api\/v1\/(?:analytics|dashboard|reporting|reports)(?:\/|$)/u,
  /^\/api\/v1\/(?:replies|inbox-reality|reputation|sender-reputation)(?:\/|$)/u,
  /^\/api\/v1\/(?:deliverability|dns-health|isp-breakdown|list-health)(?:\/|$)/u,
  /^\/api\/v1\/(?:cost|costs|growth-source|predictive)(?:\/|$)/u,
];
const ADMIN_FAMILY = [
  /^\/api\/v1\/(?:admin|api-keys|api-usage|security|billing)(?:\/|$)/u,
  /^\/api\/v1\/(?:webhooks|outbound-webhooks|inbound-webhooks|inbound-emails)(?:\/|$)/u,
  /^\/api\/v1\/(?:integrations|crm|commerce|developer-marketplace)(?:\/|$)/u,
  /^\/api\/v1\/(?:migrations|scim|byok|warehouse|agency)(?:\/|$)/u,
  /^\/api\/v1\/(?:settings|privacy|sar|compliance)(?:\/|$)/u,
  /^\/api\/v1\/(?:sending-identities|custom-domains|domain-warmup)(?:\/|$)/u,
  /^\/api\/v1\/sms\/(?:senders|credits)(?:\/|$)/u,
];
const SESSION_ONLY_FAMILY = [
  /^\/api\/v1\/account(?:\/|$)/u,
  // Continuity (cursor + draft checkpoint). Both are one PERSON's state: which
  // entity they were last on, and what they had typed into it. A shared API key
  // has no single "last-viewed" entity and no owner whose unfinished draft it
  // would be reading, so both are mounted behind RequireAuthMethod(session) and
  // the manifest must say so — otherwise it advertises an api_key path the
  // route refuses.
  //
  // Being here also fixes the role. The generic fallback for a mutation with no
  // mapped scope is admin, deliberately fail-closed; applied to these it would
  // mean a viewer or editor cannot record their own cursor or save their own
  // draft, which breaks the feature for almost everyone who uses it. A person
  // writing their OWN per-user state needs no elevation, which is exactly the
  // rule this family already encodes for /account and /auth/sessions.
  /^\/api\/v1\/activity\/last-viewed$/u,
  /^\/api\/v1\/editor\/checkpoints(?:\/|$)/u,
  /^\/api\/v1\/mobile\/push(?:\/|$)/u,
  /^\/api\/v1\/notifications(?:\/|$)/u,
  // trusted-devices (AUTH#48) belongs here for the same reason sessions does:
  // these are the caller's OWN credentials. No API key may enumerate or revoke
  // somebody's MFA bypasses, and a viewer must be able to kill their own.
  /^\/api\/v1\/auth\/(?:me|send-verification|totp|webauthn|oauth|sessions|trusted-devices|viewer-mode|cli)(?:\/|$)/u,
];

function normalizePath(path) {
  let out = path.replace(/\/\*$/u, "/{rest}");
  out = out.replace(/\{([^}:]+):[^}]+\}/gu, "{$1}");
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function routeKey(method, path) {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

function extractGatewayRoutes() {
  return gatewayRouteInventory(repoRoot).routes;
}

function loadOpenAPI() {
  const raw = readFileSync(specPath, "utf8");
  const operations = new Map();
  const lines = raw.split(/\r?\n/u);
  let pathsIndent = -1;
  let currentPath = "";
  let pathIndent = -1;
  let currentOperation = null;
  let operationIndent = -1;
  let collectingScopes = false;
  let collectingSecurity = false;

  for (const rawLine of lines) {
    const line = rawLine.replaceAll("\t", "    ");
    const indent = line.match(/^(\s*)/u)?.[1].length ?? 0;
    const text = line.trim();
    if (pathsIndent < 0) {
      if (text === "paths:") pathsIndent = indent;
      continue;
    }
    if (text !== "" && indent <= pathsIndent) break;
    if (
      indent === pathsIndent + 2 &&
      text.startsWith("/") &&
      text.endsWith(":")
    ) {
      currentPath = text.slice(0, -1);
      pathIndent = indent;
      currentOperation = null;
      collectingScopes = false;
      collectingSecurity = false;
      continue;
    }
    const methodMatch = text.match(/^([a-z]+):\s*$/u);
    if (
      currentPath &&
      indent === pathIndent + 2 &&
      methodMatch &&
      HTTP_METHODS.has(methodMatch[1])
    ) {
      currentOperation = {};
      operationIndent = indent;
      collectingScopes = false;
      collectingSecurity = false;
      operations.set(routeKey(methodMatch[1], currentPath), currentOperation);
      continue;
    }
    if (!currentOperation || indent <= operationIndent) {
      collectingScopes = false;
      collectingSecurity = false;
      continue;
    }

    if (collectingSecurity) {
      const schemeMatch = text.match(/^-\s+([A-Za-z0-9_]+):/u);
      if (indent > operationIndent + 2 && schemeMatch) {
        currentOperation.security.push(schemeMatch[1]);
        continue;
      }
      collectingSecurity = false;
    }
    if (collectingScopes) {
      const scopeMatch = text.match(/^-\s+(.+)$/u);
      if (indent > operationIndent + 2 && scopeMatch) {
        currentOperation["x-required-scopes"].push(
          unquoteYAMLScalar(scopeMatch[1]),
        );
        continue;
      }
      collectingScopes = false;
    }
    if (indent !== operationIndent + 2) continue;

    if (text === "security: []") {
      currentOperation.security = [];
      continue;
    }
    if (text === "security:") {
      currentOperation.security = [];
      collectingSecurity = true;
      continue;
    }
    const scopesMatch = text.match(/^x-required-scopes:\s*(.*)$/u);
    if (scopesMatch) {
      const value = scopesMatch[1].trim();
      if (value.startsWith("[") && value.endsWith("]")) {
        const inner = value.slice(1, -1).trim();
        currentOperation["x-required-scopes"] = inner
          ? inner.split(",").map((scope) => unquoteYAMLScalar(scope.trim()))
          : [];
      } else {
        currentOperation["x-required-scopes"] = [];
        collectingScopes = true;
      }
      continue;
    }
    for (const key of [
      "x-required-auth-method",
      "x-required-role",
      "x-required-scope-mode",
      "x-postwave-release-hold",
    ]) {
      const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "u"));
      if (match) currentOperation[key] = unquoteYAMLScalar(match[1]);
    }
  }
  if (operations.size === 0)
    throw new Error("OpenAPI contains zero operations");
  return { operations, raw };
}

function unquoteYAMLScalar(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isPublicRoute(method, path, operation, contract) {
  if (path.startsWith("/api/public/")) return true;
  if (path.startsWith("/api/status/")) return true;
  if (
    new Set([
      "/api/health",
      "/api/ready",
      "/api/regions",
      "/api/regions/current",
      "/api/v1/healthz",
      "/api/v1/status/public",
    ]).has(path)
  ) {
    return true;
  }
  if (Array.isArray(operation?.security) && operation.security.length === 0) {
    return true;
  }
  if (method === "POST" && path === "/api/v1/auth/cli/device/start") {
    return true;
  }
  if (method === "GET" && /\/oauth\/callback$/u.test(path)) return true;
  return new Set([
    "public-token-or-embed",
    "public-bootstrap",
    "public-status",
    "health-probe",
    "developer-docs",
    "browser-telemetry",
    // Distinct from public-token-or-embed, where the ticket IS the credential.
    // Here there is no credential at all and there cannot be one: DSA Art. 16(1)
    // requires the notice mechanism to be usable by "any individual or entity",
    // so a session or token gate would exclude exactly the people it exists for.
    "public-notice-and-action",
  ]).has(contract?.exposure);
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => pattern.test(path));
}

function inferredScope(method, path) {
  const read = READ_METHODS.has(method);
  const specific = routeSpecificScope(method, path);
  if (specific) return specific;
  if (/^\/api\/v1\/audit(?:\/|$)/u.test(path)) {
    return {
      scopes: [read ? "audit:read" : "audit:execute_actions"],
      source: "family:audit",
    };
  }
  if (matchesAny(path, ADMIN_FAMILY)) {
    return { scopes: ["admin"], source: "family:admin" };
  }
  if (matchesAny(path, SUBSCRIBER_FAMILY)) {
    return {
      scopes: [read ? "read:subscribers" : "write:subscribers"],
      source: "family:subscribers",
    };
  }
  if (matchesAny(path, CAMPAIGN_FAMILY)) {
    return {
      scopes: [read ? "read:campaigns" : "write:campaigns"],
      source: "family:campaigns",
    };
  }
  if (read && matchesAny(path, REPORT_FAMILY)) {
    return { scopes: ["read:reports"], source: "family:reports" };
  }
  return {
    scopes: [read ? "read:reports" : "admin"],
    source: read ? "safe-default:read" : "safe-default:admin",
  };
}

function routeSpecificScope(method, path) {
  const read = READ_METHODS.has(method);
  if (path === "/api/v1/service-suite/catalog" && method === "GET") {
    return {
      scopes: ["read:reports"],
      source: "route:service-suite-static-catalog",
    };
  }
  if (
    /^\/api\/v1\/service-suite(?:\/|$)/u.test(path) ||
    /^\/api\/v1\/support-integrations(?:\/|$)/u.test(path)
  ) {
    return { scopes: ["admin"], source: "route-family:helpdesk-exact-admin" };
  }
  if (/^\/api\/v1\/lists\/\{[^}]+\}\/webhooks(?:\/|$)/u.test(path)) {
    return { scopes: ["admin"], source: "route-family:list-webhooks-admin" };
  }
  if (/^\/api\/v1\/deliverability\/suppressions(?:\/|$)/u.test(path)) {
    return {
      scopes: [read ? "read:subscribers" : "admin"],
      source: "route-family:deliverability-suppressions",
    };
  }
  if (
    /^\/api\/v1\/suppressions\/(?:bulk-import|bulk-delete|bulk-action|mirror\/)/u.test(
      path,
    ) ||
    (method === "PATCH" && /^\/api\/v1\/suppressions\/\{[^}]+\}$/u.test(path))
  ) {
    return { scopes: ["admin"], source: "route-family:suppressions-admin" };
  }
  if (path === "/api/v1/streams/token") {
    return { scopes: ["read:reports"], source: "route:stream-token" };
  }
  if (/^\/api\/v1\/sms\/broadcasts(?:\/|$)/u.test(path)) {
    return { scopes: ["admin"], source: "route-family:sms-exact-admin" };
  }
  if (/^\/api\/v1\/sms\/suppressions(?:\/|$)/u.test(path)) {
    return { scopes: ["admin"], source: "route-family:sms-exact-admin" };
  }
  if (/^\/api\/v1\/sms\/conversations(?:[./]|$)/u.test(path)) {
    return { scopes: ["admin"], source: "route-family:sms-inbox-admin" };
  }
  if (/^\/api\/v1\/sms\/quick-replies(?:\/|$)/u.test(path)) {
    return { scopes: ["admin"], source: "route-family:sms-inbox-admin" };
  }
  if (
    method === "POST" &&
    new Set([
      "/api/v1/sms/credits/preview",
      "/api/v1/sms/credits/top-ups/quote",
    ]).has(path)
  ) {
    return { scopes: ["read:reports"], source: "route-family:sms-credit-read" };
  }
  if (
    method === "GET" &&
    new Set(["/api/v1/sms/templates", "/api/v1/sms/discount-codes"]).has(path)
  ) {
    return { scopes: ["read:campaigns"], source: "route-family:sms-catalog" };
  }
  if (method === "GET" && path === "/api/v1/sms/senders/pilot-certifications") {
    return { scopes: ["read:reports"], source: "route-family:sms-sender-read" };
  }
  if (method === "POST" && path === "/api/v1/sms/test-send") {
    return { scopes: ["write:campaigns"], source: "route:sms-test-send" };
  }
  return null;
}

function minimumRole(scopes, explicitRole) {
  if (explicitRole != null) {
    const normalized = String(explicitRole).trim().toLowerCase();
    if (!VALID_ROLES.has(normalized)) {
      throw new Error(
        `invalid x-required-role ${JSON.stringify(explicitRole)}`,
      );
    }
    return normalized;
  }
  if (
    scopes.every((scope) => scope.startsWith("read:") || scope === "audit:read")
  ) {
    return "viewer";
  }
  if (
    scopes.every((scope) =>
      new Set([
        "read:subscribers",
        "write:subscribers",
        "read:campaigns",
        "write:campaigns",
        "read:reports",
        "audit:read",
      ]).has(scope),
    ) &&
    scopes.some(
      (scope) => scope === "write:subscribers" || scope === "write:campaigns",
    )
  ) {
    return "editor";
  }
  return "admin";
}

function buildPolicy(route, operation, contract) {
  const firstSpace = route.indexOf(" ");
  const method = route.slice(0, firstSpace);
  const path = route.slice(firstSpace + 1);

  const releaseHoldCode =
    operation?.["x-postwave-release-hold"] ?? contract?.release_hold_code;
  if (releaseHoldCode != null) {
    if (!/^[a-z][a-z0-9_]{2,127}$/u.test(String(releaseHoldCode))) {
      throw new Error(`invalid release-hold code for ${route}`);
    }
    return {
      method,
      path,
      exposure: "release-held",
      auth_methods: ["pre_auth_release_hold"],
      session_minimum_role: "not_applicable",
      api_key_scopes: [],
      api_key_scope_mode: "not_applicable",
      release_hold_code: String(releaseHoldCode),
      policy_source:
        operation?.["x-postwave-release-hold"] != null
          ? "openapi.x-postwave-release-hold"
          : "route-contract.release_hold_code",
      review_status: "release_held",
    };
  }

  // `/api/internal/web-vitals` is an intentionally anonymous browser-ingest
  // endpoint despite its historical path prefix. Only an exact reviewed
  // contract may override the internal-token default; a pattern must never
  // make another `/api/internal/*` route anonymous by inheritance.
  if (contract?.exposure === "browser-telemetry") {
    if (contract.route !== route || contract.auth_method !== "anonymous") {
      throw new Error(
        `${route} browser-telemetry policy must come from an exact anonymous route contract`,
      );
    }
    return {
      method,
      path,
      exposure: "public",
      auth_methods: ["anonymous_or_route_credential"],
      session_minimum_role: "not_applicable",
      api_key_scopes: [],
      api_key_scope_mode: "not_applicable",
      policy_source: "route-contract:browser-telemetry",
      review_status: "handler_boundary",
    };
  }

  if (path.startsWith("/api/internal/")) {
    return {
      method,
      path,
      exposure: "internal",
      auth_methods: ["internal_token_or_provider_signature"],
      session_minimum_role: "not_applicable",
      api_key_scopes: [],
      api_key_scope_mode: "not_applicable",
      policy_source: "route-prefix:internal",
      review_status: "handler_boundary",
    };
  }
  // Computed BEFORE the public branch on purpose.
  //
  // `security: []` on an operation means "no HTTP auth scheme", which is true of
  // an RFC 8628 device-token endpoint — the caller proves itself with a
  // `device_code` in the BODY, not a header. It does not mean "no credential".
  // Taking the public branch first collapsed those two into `public` and made
  // this branch unreachable for any operation carrying an explicit empty
  // security array, so POST /api/v1/auth/cli/device/token — which hands back an
  // API key — was described in the generated manifest as anonymous.
  //
  // Enforcement did not change (routeauth passes both public and credentialed
  // through to the handler's own boundary), which is exactly why it went
  // unnoticed: the only symptom was a manifest that read as if an
  // API-key-issuing endpoint took no credential at all.
  const credentialAuthMethods = credentialedAuthMethods(
    method,
    path,
    operation,
  );
  if (credentialAuthMethods.length === 0 && isPublicRoute(method, path, operation, contract)) {
    return {
      method,
      path,
      exposure: "public",
      auth_methods: ["anonymous_or_route_credential"],
      session_minimum_role: "not_applicable",
      api_key_scopes: [],
      api_key_scope_mode: "not_applicable",
      policy_source:
        Array.isArray(operation?.security) && operation.security.length === 0
          ? "openapi.security"
          : contract
            ? `route-contract:${contract.exposure}`
            : "reviewed-public-prefix",
      review_status: "handler_boundary",
    };
  }
  if (credentialAuthMethods.length > 0) {
    return {
      method,
      path,
      exposure: "credentialed",
      auth_methods: credentialAuthMethods,
      session_minimum_role: "not_applicable",
      api_key_scopes: [],
      api_key_scope_mode: "not_applicable",
      policy_source: "openapi-or-reviewed-handler-credential",
      review_status: "handler_boundary",
    };
  }

  const contractAuthorization = contract?.authorization;
  if (method === "GET" && path === "/api/v1/me") {
    return {
      method,
      path,
      exposure: "authenticated",
      auth_methods: ["session", "api_key"],
      session_minimum_role: "viewer",
      api_key_scopes: [],
      api_key_scope_mode: "authenticated",
      policy_source: "route:self-projection",
      review_status: "reviewed",
    };
  }
  if (
    contractAuthorization === "verified-api-key-auth-method-and-self-projection"
  ) {
    return {
      method,
      path,
      exposure: "authenticated",
      auth_methods: ["api_key"],
      session_minimum_role: "not_applicable",
      api_key_scopes: [],
      api_key_scope_mode: "authenticated",
      policy_source: "route-contract.authorization",
      review_status: "reviewed",
    };
  }

  // Gateway-only reviewed contracts can carry the same explicit conjunctive
  // scope policy as OpenAPI operations without forcing an internal-only route
  // into the public SDK specification.
  const contractScopes = contract?.api_key_scopes;
  const explicitScopes =
    operation?.["x-required-scopes"] ?? contractScopes;
  if (explicitScopes != null && !Array.isArray(explicitScopes)) {
    throw new Error(`${route} x-required-scopes must be an array`);
  }
  let scopes;
  let policySource;
  if (Array.isArray(explicitScopes) && explicitScopes.length > 0) {
    scopes = [...new Set(explicitScopes.map((scope) => String(scope).trim()))];
    policySource = operation?.["x-required-scopes"] != null
      ? "openapi.x-required-scopes"
      : "route-contract.api_key_scopes";
  } else if (contractAuthorization === "tenant-admin") {
    scopes = ["admin"];
    policySource = "route-contract.authorization";
  } else {
    ({ scopes, source: policySource } = inferredScope(method, path));
    if (
      contractAuthorization === "tenant-principal-and-route-read-scope" ||
      contractAuthorization ===
        "tenant-principal-and-route-write-or-admin-scope"
    ) {
      policySource = `route-contract.authorization+${policySource}`;
    }
  }
  for (const scope of scopes) {
    if (!VALID_SCOPES.has(scope)) {
      throw new Error(`${route} names unknown API-key scope ${scope}`);
    }
  }

  const explicitScopeMode =
    operation?.["x-required-scope-mode"] ?? contract?.api_key_scope_mode;
  let scopeMode = "any";
  if (explicitScopeMode != null) {
    scopeMode = String(explicitScopeMode).trim().toLowerCase();
    if (!new Set(["any", "all"]).has(scopeMode)) {
      throw new Error(
        `${route} has invalid x-required-scope-mode ${JSON.stringify(explicitScopeMode)}`,
      );
    }
    if (!Array.isArray(explicitScopes) || explicitScopes.length === 0) {
      throw new Error(
        `${route} x-required-scope-mode requires non-empty x-required-scopes`,
      );
    }
    if (scopeMode === "all" && scopes.length < 2) {
      throw new Error(
        `${route} x-required-scope-mode all requires at least two distinct scopes`,
      );
    }
    const scopeModeSource =
      operation?.["x-required-scope-mode"] != null
        ? "openapi.x-required-scope-mode"
        : "route-contract.api_key_scope_mode";
    policySource = `${scopeModeSource}+${policySource}`;
  }

  const explicitMethod =
    operation?.["x-required-auth-method"] ?? contract?.auth_method;
  let authMethods = ["session", "api_key"];
  if (explicitMethod != null) {
    const normalized = String(explicitMethod).trim().toLowerCase();
    if (!VALID_AUTH_METHODS.has(normalized)) {
      throw new Error(
        `${route} has invalid x-required-auth-method ${JSON.stringify(explicitMethod)}`,
      );
    }
    authMethods = [normalized];
    policySource = operation?.["x-required-auth-method"] != null
      ? `openapi.x-required-auth-method+${policySource}`
      : `route-contract.auth_method+${policySource}`;
  } else if (matchesAny(path, SESSION_ONLY_FAMILY)) {
    authMethods = ["session"];
    policySource += "+family:session-only";
  }

  const apiKeyAllowed = authMethods.includes("api_key");
  const sessionFamily = matchesAny(path, SESSION_ONLY_FAMILY);
  const explicitRole =
    operation?.["x-required-role"] ?? contract?.session_minimum_role;
  const role = authMethods.includes("session")
    ? sessionFamily && explicitRole == null
      ? "viewer"
      : minimumRole(scopes, explicitRole)
    : "not_applicable";
  return {
    method,
    path,
    exposure: "authenticated",
    auth_methods: authMethods,
    session_minimum_role: role,
    api_key_scopes: apiKeyAllowed ? scopes : [],
    api_key_scope_mode: apiKeyAllowed ? scopeMode : "not_applicable",
    policy_source: policySource,
    review_status: policySource.startsWith("safe-default:")
      ? "fail_closed_default"
      : "reviewed",
  };
}

function credentialedAuthMethods(method, path, operation) {
  const schemes = Array.isArray(operation?.security) ? operation.security : [];
  const customSchemes = schemes.filter(
    (scheme) =>
      !new Set(["bearerAuth", "sessionCookie", "tenantHeader"]).has(scheme),
  );
  if (customSchemes.length > 0) {
    return customSchemes.map((scheme) => {
      if (scheme === "portalCookie") return "portal_cookie";
      if (scheme === "pipedriveOAuthBasic") return "provider_basic";
      return `openapi_security:${scheme}`;
    });
  }
  if (
    method === "POST" &&
    new Set(["/api/v1/slack/interactions", "/api/v1/slack/commands"]).has(path)
  ) {
    return ["provider_signature"];
  }
  if (method === "POST" && path === "/api/v1/auth/cli/token") {
    return ["pkce_code_verifier"];
  }
  if (method === "POST" && path === "/api/v1/auth/cli/device/token") {
    return ["device_code"];
  }
  return [];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function buildManifest() {
  const gateway = extractGatewayRoutes();
  if (gateway.size === 0) throw new Error("zero gateway routes parsed");
  const { operations, raw: openapiRaw } = loadOpenAPI();
  const contracts = loadRouteContracts(contractsPath);

  const gatewayPaths = new Set(
    [...gateway].map((route) => route.slice(route.indexOf(" ") + 1)),
  );
  const wildcardPrefixes = [...gatewayPaths]
    .filter((path) => path.endsWith("/{rest}"))
    .map((path) => path.slice(0, -"/{rest}".length));
  const missingSpecRoutes = [...operations.keys()].filter((route) => {
    if (gateway.has(route)) return false;
    const path = route.slice(route.indexOf(" ") + 1);
    if (gatewayPaths.has(path)) return false;
    return !wildcardPrefixes.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
  });
  if (missingSpecRoutes.length > 0) {
    throw new Error(
      `OpenAPI routes missing from reachable gateway:\n${missingSpecRoutes
        .sort()
        .map((route) => `  - ${route}`)
        .join("\n")}`,
    );
  }

  const specPaths = new Set(
    [...operations.keys()].map((route) => route.slice(route.indexOf(" ") + 1)),
  );
  const gatewayOnly = [...gateway]
    .filter((route) => {
      if (operations.has(route)) return false;
      if (route.startsWith("ANY ") && specPaths.has(route.slice(4))) {
        return false;
      }
      return !route.endsWith("/{rest}");
    })
    .sort();
  validateGatewayOnlyContracts({
    contracts,
    gatewayRoutes: gateway,
    gatewayOnlyRoutes: gatewayOnly,
  });

  const routes = [];
  for (const route of [...gateway].sort()) {
    const operation = operations.get(route);
    const contract = contractForRoute(route, contracts);
    if (!operation && !contract) {
      throw new Error(
        `${route} is gateway-only but lacks a reviewed route-contract`,
      );
    }
    routes.push(buildPolicy(route, operation, contract));
  }

  const manifest = {
    schema_version: 1,
    generated_from: {
      openapi_yaml_sha256: sha256(openapiRaw),
      route_contracts_sha256: sha256(contracts.rawText),
      route_reachability_sha256: sha256(readFileSync(reachabilityPath, "utf8")),
    },
    policy_notes: {
      role_order: ["viewer/member", "editor", "admin", "owner"],
      member_compatibility:
        "Legacy member sessions have viewer-equivalent read access and no editor/admin mutation access.",
      unknown_mutations:
        "Legacy mutations without an explicit scope or reviewed family mapping require admin.",
    },
    routes,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const generated = buildManifest();
const check = process.argv.includes("--check");
const decisions = process.argv.includes("--decisions");

if (check) {
  let existing = "";
  try {
    existing = readFileSync(outputPath, "utf8");
  } catch {
    // Report the same actionable mismatch as stale content.
  }
  if (existing !== generated) {
    console.error(
      "Route capability manifest is stale. Run: node scripts/generate-route-capabilities.mjs",
    );
    process.exit(1);
  }
} else {
  writeFileSync(outputPath, generated);
}

const parsed = JSON.parse(generated);
const counts = parsed.routes.reduce((acc, route) => {
  acc[route.exposure] = (acc[route.exposure] ?? 0) + 1;
  return acc;
}, {});
const fallbacks = parsed.routes.filter(
  (route) => route.review_status === "fail_closed_default",
);
console.log(
  `Route capabilities OK: ${parsed.routes.length} routes ` +
    `(${Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => `${name}: ${count}`)
      .join(", ")}); ${fallbacks.length} use a fail-closed legacy default.`,
);
if (decisions && fallbacks.length > 0) {
  console.log(
    "\nFail-closed defaults awaiting optional product-policy relaxation:",
  );
  for (const route of fallbacks) {
    const decision =
      route.api_key_scopes[0] ?? `session role ${route.session_minimum_role}`;
    console.log(`  ${route.method} ${route.path} -> ${decision}`);
  }
}
