#!/usr/bin/env node

// Fail-closed quality ledger for the two Moosewave OpenAPI documents.
//
// Route parity answers "is a route represented?". It does not answer whether
// a prospective client can safely use that operation. This gate therefore
// measures the remaining generated/underspecified contract debt exactly. A
// decrease is welcome but makes the baseline stale so the improvement must be
// reviewed and retained; an increase is a regression and fails immediately.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const baselinePath = resolve(
  repoRoot,
  "packages/openapi/contract-quality-baseline.json",
);
const fullSpecPath = resolve(repoRoot, "packages/openapi/openapi.json");
const curatedSpecPath = resolve(
  repoRoot,
  "packages/openapi/surfaces/openapi.yaml",
);
const manifestPath = resolve(
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
const MUTATING_METHODS = new Set(["post", "put", "patch"]);
const BODYLESS_SUCCESS = new Set(["204", "205"]);
const GENERIC_DESCRIPTION =
  /(?:Retrieves the current representation exposed by|Executes the operation exposed by|Creates or replaces the representation addressed by|Applies a partial update through|Deletes or deactivates the resource addressed by|Returns protocol capabilities for|Implements the `?[A-Z]+ )/u;
const GENERATED_RESPONSE =
  /Endpoint-specific JSON payload; see x-postwave-source and SDK resource docs\./u;
const GENERIC_SUMMARY =
  /^(?:Request|List|Get|Create|Update|Delete|Add|Remove)$/u;
const HANDLER_FRAGMENT_SUMMARY =
  /(?:\b[A-Za-z_][A-Za-z0-9_]*Handler\s*\(|\([^)]*$)/u;

const FULL_DEBT_METRICS = new Set([
  "generic_operation_descriptions",
  "generated_response_descriptions",
  "handler_fragment_summaries",
  "generic_one_word_summaries",
  "body_success_operations_without_schema",
  "operations_without_error_response",
  "mutations_without_request_body",
  "public_generic_operation_descriptions",
  "public_generated_response_descriptions",
  "public_body_success_operations_without_schema",
  "public_operations_without_error_response",
  "public_mutations_without_request_body",
  "unclassified_spec_operations",
  "root_tenant_header_only_security_alternatives",
  "unresolved_local_refs",
]);
const CURATED_DEBT_METRICS = new Set([
  "operations_without_description",
  "operations_without_security",
  "body_success_operations_without_schema",
  "operations_without_error_response",
  "mutations_without_request_body",
  "operations_without_examples",
  "runtime_route_mismatches",
  "security_exposure_mismatches",
  "missing_or_mismatched_scope_contracts",
  "missing_or_mismatched_scope_modes",
  "unresolved_security_schemes",
  "duplicate_operation_ids",
  "unresolved_local_refs",
]);

function parseJSON(path, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function parseYAML(path, label) {
  const document = YAML.parseDocument(readFileSync(path, "utf8"), {
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `${label} is not valid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const value = document.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a YAML object`);
  }
  return value;
}

function normalizePath(path) {
  let normalized = path.replace(/\/\*$/u, "/{rest}");
  normalized = normalized.replace(/\{([^}:]+):[^}]+\}/gu, "{$1}");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function routeKey(method, path) {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

function operations(document) {
  if (!document.paths || typeof document.paths !== "object") {
    throw new Error("OpenAPI document contains no paths object");
  }
  const result = [];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!pathItem || typeof pathItem !== "object" || Array.isArray(pathItem)) {
      continue;
    }
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (
        !operation ||
        typeof operation !== "object" ||
        Array.isArray(operation)
      ) {
        throw new Error(
          `${method.toUpperCase()} ${path} must be an operation object`,
        );
      }
      result.push({
        method: method.toLowerCase(),
        path,
        key: routeKey(method, path),
        operation,
      });
    }
  }
  return result.sort((left, right) => left.key.localeCompare(right.key));
}

function responseEntries(operation) {
  if (!operation.responses || typeof operation.responses !== "object") {
    return [];
  }
  return Object.entries(operation.responses);
}

function hasSuccessSchema(operation) {
  const successes = responseEntries(operation).filter(
    ([status]) => /^2\d\d$/u.test(status) && !BODYLESS_SUCCESS.has(status),
  );
  if (successes.length === 0) return true;
  return successes.some(([, response]) => {
    if (!response || typeof response !== "object") return false;
    if (!response.content || typeof response.content !== "object") return false;
    return Object.values(response.content).some(
      (media) => media && typeof media === "object" && media.schema,
    );
  });
}

function hasErrorResponse(operation) {
  return responseEntries(operation).some(
    ([status]) => status === "default" || /^[45]\d\d$/u.test(status),
  );
}

function generatedResponseCount(operation) {
  let count = 0;
  for (const [, response] of responseEntries(operation)) {
    if (
      response &&
      typeof response === "object" &&
      GENERATED_RESPONSE.test(String(response.description ?? ""))
    ) {
      count += 1;
    }
  }
  return count;
}

function localRefCount(document) {
  let unresolved = 0;
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
      let cursor = document;
      for (const rawPart of value.$ref.slice(2).split("/")) {
        const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
        if (!cursor || typeof cursor !== "object" || !(part in cursor)) {
          unresolved += 1;
          cursor = undefined;
          break;
        }
        cursor = cursor[part];
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(document);
  return unresolved;
}

function manifestExposureMap(manifest) {
  if (!Array.isArray(manifest.routes) || manifest.routes.length === 0) {
    throw new Error("route capability manifest contains no routes");
  }
  const exact = new Map();
  const wildcards = [];
  for (const route of manifest.routes) {
    const key = routeKey(String(route.method ?? ""), String(route.path ?? ""));
    if (exact.has(key)) throw new Error(`duplicate route capability ${key}`);
    const exposure = String(route.exposure ?? "");
    exact.set(key, route);
    if (String(route.method).toUpperCase() === "ANY") {
      const path = normalizePath(String(route.path ?? ""));
      if (path.endsWith("/{rest}")) {
        wildcards.push({
          prefix: path.slice(0, -"/{rest}".length),
          route,
        });
      }
    }
  }
  wildcards.sort((left, right) => right.prefix.length - left.prefix.length);
  return {
    routeFor(method, path) {
      const normalized = normalizePath(path);
      const direct =
        exact.get(routeKey(method, normalized)) ??
        exact.get(routeKey("ANY", normalized));
      if (direct) return direct;
      return wildcards.find(
        (entry) =>
          normalized === entry.prefix ||
          normalized.startsWith(`${entry.prefix}/`),
      )?.route;
    },
    exposureFor(method, path) {
      return this.routeFor(method, path)?.exposure;
    },
  };
}

function measureFull(document, manifest) {
  const entries = operations(document);
  const exposure = manifestExposureMap(manifest);
  const metrics = {
    operations_total: entries.length,
    public_operations_total: 0,
    generic_operation_descriptions: 0,
    generated_response_descriptions: 0,
    handler_fragment_summaries: 0,
    generic_one_word_summaries: 0,
    body_success_operations_without_schema: 0,
    operations_without_error_response: 0,
    mutations_without_request_body: 0,
    public_generic_operation_descriptions: 0,
    public_generated_response_descriptions: 0,
    public_body_success_operations_without_schema: 0,
    public_operations_without_error_response: 0,
    public_mutations_without_request_body: 0,
    unclassified_spec_operations: 0,
    root_tenant_header_only_security_alternatives: 0,
    unresolved_local_refs: localRefCount(document),
  };

  for (const entry of entries) {
    const description = String(entry.operation.description ?? "").trim();
    const summary = String(entry.operation.summary ?? "").trim();
    const generatedDescription = GENERIC_DESCRIPTION.test(description);
    const generatedResponses = generatedResponseCount(entry.operation);
    const missingSuccessSchema = !hasSuccessSchema(entry.operation);
    const missingErrors = !hasErrorResponse(entry.operation);
    const missingBody =
      MUTATING_METHODS.has(entry.method) &&
      !entry.operation.requestBody &&
      entry.operation["x-postwave-bodyless"] !== true;
    const routeExposure = exposure.exposureFor(entry.method, entry.path);
    const isPublic = routeExposure === "public";

    if (generatedDescription) metrics.generic_operation_descriptions += 1;
    metrics.generated_response_descriptions += generatedResponses;
    if (HANDLER_FRAGMENT_SUMMARY.test(summary)) {
      metrics.handler_fragment_summaries += 1;
    }
    if (GENERIC_SUMMARY.test(summary)) metrics.generic_one_word_summaries += 1;
    if (missingSuccessSchema) {
      metrics.body_success_operations_without_schema += 1;
    }
    if (missingErrors) metrics.operations_without_error_response += 1;
    if (missingBody) metrics.mutations_without_request_body += 1;
    if (!routeExposure) metrics.unclassified_spec_operations += 1;

    if (isPublic) {
      metrics.public_operations_total += 1;
      if (generatedDescription) {
        metrics.public_generic_operation_descriptions += 1;
      }
      metrics.public_generated_response_descriptions += generatedResponses;
      if (missingSuccessSchema) {
        metrics.public_body_success_operations_without_schema += 1;
      }
      if (missingErrors) metrics.public_operations_without_error_response += 1;
      if (missingBody) metrics.public_mutations_without_request_body += 1;
    }
  }

  const rootSecurity = Array.isArray(document.security)
    ? document.security
    : [];
  metrics.root_tenant_header_only_security_alternatives = rootSecurity.filter(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Object.keys(entry).length === 1 &&
      Object.hasOwn(entry, "tenantHeader"),
  ).length;
  return metrics;
}

function containsExample(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Object.hasOwn(value, "example") || Object.hasOwn(value, "examples")) {
    return true;
  }
  return Object.values(value).some((child) => containsExample(child, seen));
}

function normalizedScopes(value) {
  if (
    !Array.isArray(value) ||
    value.some((scope) => typeof scope !== "string")
  ) {
    return undefined;
  }
  return [...new Set(value)].sort();
}

function securitySchemeNames(document, operation) {
  const security = Array.isArray(operation.security)
    ? operation.security
    : Array.isArray(document.security)
      ? document.security
      : undefined;
  if (!security) return undefined;
  return {
    anonymous: security.length === 0,
    names: [
      ...new Set(
        security.flatMap((requirement) =>
          requirement &&
          typeof requirement === "object" &&
          !Array.isArray(requirement)
            ? Object.keys(requirement)
            : [],
        ),
      ),
    ],
  };
}

function measureCurated(document, manifest) {
  const entries = operations(document);
  const runtime = manifestExposureMap(manifest);
  const metrics = {
    operations_total: entries.length,
    operations_without_description: 0,
    operations_without_security: 0,
    body_success_operations_without_schema: 0,
    operations_without_error_response: 0,
    mutations_without_request_body: 0,
    operations_without_examples: 0,
    runtime_route_mismatches: 0,
    security_exposure_mismatches: 0,
    missing_or_mismatched_scope_contracts: 0,
    missing_or_mismatched_scope_modes: 0,
    unresolved_security_schemes: 0,
    duplicate_operation_ids: 0,
    unresolved_local_refs: localRefCount(document),
  };
  const operationIds = new Set();
  const declaredSecuritySchemes = new Set(
    Object.keys(document.components?.securitySchemes ?? {}),
  );
  for (const entry of entries) {
    const runtimeRoute = runtime.routeFor(entry.method, entry.path);
    const effectiveSecurity = securitySchemeNames(document, entry.operation);
    const operationId = String(entry.operation.operationId ?? "").trim();
    if (!String(entry.operation.description ?? "").trim()) {
      metrics.operations_without_description += 1;
    }
    if (!effectiveSecurity) {
      metrics.operations_without_security += 1;
    }
    if (!hasSuccessSchema(entry.operation)) {
      metrics.body_success_operations_without_schema += 1;
    }
    if (!hasErrorResponse(entry.operation)) {
      metrics.operations_without_error_response += 1;
    }
    if (
      MUTATING_METHODS.has(entry.method) &&
      !entry.operation.requestBody &&
      entry.operation["x-postwave-bodyless"] !== true
    ) {
      metrics.mutations_without_request_body += 1;
    }
    if (!containsExample(entry.operation)) {
      metrics.operations_without_examples += 1;
    }
    if (!runtimeRoute) {
      metrics.runtime_route_mismatches += 1;
    } else {
      const shouldBeAnonymous = runtimeRoute.exposure === "public";
      if (
        !effectiveSecurity ||
        effectiveSecurity.anonymous !== shouldBeAnonymous
      ) {
        metrics.security_exposure_mismatches += 1;
      }
      const supportsAPIKeys = runtimeRoute.auth_methods?.includes("api_key");
      if (supportsAPIKeys) {
        const expected = normalizedScopes(runtimeRoute.api_key_scopes ?? []);
        const declared = normalizedScopes(entry.operation["x-required-scopes"]);
        if (
          !declared ||
          JSON.stringify(declared) !== JSON.stringify(expected)
        ) {
          metrics.missing_or_mismatched_scope_contracts += 1;
        }
        const declaredMode = String(
          entry.operation["x-required-scope-mode"] ?? "any",
        )
          .trim()
          .toLowerCase();
        if (declaredMode !== runtimeRoute.api_key_scope_mode) {
          metrics.missing_or_mismatched_scope_modes += 1;
        }
      }
    }
    if (effectiveSecurity) {
      metrics.unresolved_security_schemes += effectiveSecurity.names.filter(
        (name) => !declaredSecuritySchemes.has(name),
      ).length;
    }
    if (!operationId || operationIds.has(operationId)) {
      metrics.duplicate_operation_ids += 1;
    } else {
      operationIds.add(operationId);
    }
  }
  return metrics;
}

function validateMetricObject(label, actual, expected, debtMetrics) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new Error(`${label} baseline metrics must be an object`);
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `${label} baseline metric schema drift: actual=${actualKeys.join(",")} expected=${expectedKeys.join(",")}`,
    );
  }
  const failures = [];
  for (const key of actualKeys) {
    if (!Number.isSafeInteger(expected[key]) || expected[key] < 0) {
      failures.push(`${key}: baseline must be a non-negative safe integer`);
      continue;
    }
    if (actual[key] === expected[key]) continue;
    if (debtMetrics.has(key)) {
      failures.push(
        actual[key] > expected[key]
          ? `${key}: regression ${expected[key]} -> ${actual[key]}`
          : `${key}: stale baseline ${expected[key]} -> ${actual[key]} (retain the improvement)`,
      );
    } else {
      failures.push(
        `${key}: reviewed inventory changed ${expected[key]} -> ${actual[key]}`,
      );
    }
  }
  return failures;
}

function validateBaseline(baseline, actual) {
  if (baseline.version !== 1) {
    throw new Error("OpenAPI contract-quality baseline must declare version 1");
  }
  const failures = [
    ...validateMetricObject(
      "full",
      actual.full,
      baseline.documents?.full?.metrics,
      FULL_DEBT_METRICS,
    ),
    ...validateMetricObject(
      "curated",
      actual.curated,
      baseline.documents?.curated?.metrics,
      CURATED_DEBT_METRICS,
    ),
  ];
  if (failures.length > 0) {
    throw new Error(
      `OpenAPI contract-quality ratchet failed:\n  - ${failures.join("\n  - ")}`,
    );
  }
}

function measureRepository() {
  const full = parseJSON(fullSpecPath, "full OpenAPI JSON");
  const curated = parseYAML(curatedSpecPath, "curated OpenAPI YAML");
  const manifest = parseJSON(manifestPath, "route capability manifest");
  return {
    full: measureFull(full, manifest),
    curated: measureCurated(curated, manifest),
  };
}

function formatMetrics(name, metrics) {
  return `${name}: ${Object.entries(metrics)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ")}`;
}

function selfTest() {
  const full = {
    openapi: "3.1.0",
    security: [{ bearerAuth: [] }, { tenantHeader: [] }],
    paths: {
      "/api/v1/curated": {
        get: {
          summary: "Get curated resource",
          description: "Returns the curated resource with a stable schema.",
          responses: {
            200: {
              description: "Curated resource.",
              content: { "application/json": { schema: { type: "object" } } },
            },
            401: { description: "Authentication required." },
          },
        },
      },
      "/api/public/generated": {
        post: {
          summary: "Request",
          description:
            "Executes the operation exposed by `POST /api/public/generated`.",
          responses: {
            200: {
              description:
                "Endpoint-specific JSON payload; see x-postwave-source and SDK resource docs.",
            },
          },
        },
      },
    },
    components: { schemas: { Present: { type: "object" } } },
  };
  const manifest = {
    routes: [
      {
        method: "GET",
        path: "/api/v1/curated",
        exposure: "authenticated",
        auth_methods: ["session", "api_key"],
        api_key_scopes: ["read:curated"],
        api_key_scope_mode: "any",
      },
      {
        method: "POST",
        path: "/api/public/generated",
        exposure: "public",
        auth_methods: ["anonymous_or_route_credential"],
        api_key_scopes: [],
        api_key_scope_mode: "not_applicable",
      },
    ],
  };
  const curated = {
    openapi: "3.1.0",
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/v1/curated": {
        get: {
          summary: "Get curated resource",
          description: "Returns one curated resource.",
          "x-required-scopes": ["read:curated"],
          responses: {
            200: {
              description: "Curated resource.",
              content: {
                "application/json": {
                  schema: { type: "object" },
                  example: { id: "example" },
                },
              },
            },
            401: { description: "Authentication required." },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
  };
  const actual = {
    full: measureFull(full, manifest),
    curated: measureCurated(curated, manifest),
  };
  const baseline = {
    version: 1,
    documents: {
      full: { metrics: { ...actual.full } },
      curated: { metrics: { ...actual.curated } },
    },
  };
  validateBaseline(baseline, actual);

  const reviewedBodyless = structuredClone(full);
  reviewedBodyless.paths["/api/public/generated"].post[
    "x-postwave-bodyless"
  ] = true;
  assert.equal(
    measureFull(reviewedBodyless, manifest).mutations_without_request_body,
    actual.full.mutations_without_request_body - 1,
  );

  const regression = structuredClone(actual);
  regression.full.generic_operation_descriptions += 1;
  assert.throws(() => validateBaseline(baseline, regression), /regression/u);
  const improvement = structuredClone(actual);
  improvement.full.generic_operation_descriptions -= 1;
  assert.throws(
    () => validateBaseline(baseline, improvement),
    /stale baseline/u,
  );
  const inventory = structuredClone(actual);
  inventory.curated.operations_total += 1;
  assert.throws(
    () => validateBaseline(baseline, inventory),
    /reviewed inventory changed/u,
  );
  const unclassified = structuredClone(full);
  unclassified.paths["/api/v1/unclassified"] = {
    get: structuredClone(full.paths["/api/v1/curated"].get),
  };
  assert.equal(
    measureFull(unclassified, manifest).unclassified_spec_operations,
    1,
  );
  const brokenRef = structuredClone(curated);
  brokenRef.paths["/api/v1/curated"].get.responses[200].content[
    "application/json"
  ].schema = { $ref: "#/components/schemas/Missing" };
  assert.equal(measureCurated(brokenRef, manifest).unresolved_local_refs, 1);
  const nonexistentRoute = structuredClone(curated);
  nonexistentRoute.paths["/api/v1/nonexistent"] =
    nonexistentRoute.paths["/api/v1/curated"];
  delete nonexistentRoute.paths["/api/v1/curated"];
  assert.equal(
    measureCurated(nonexistentRoute, manifest).runtime_route_mismatches,
    1,
  );
  const publicAuthMismatch = structuredClone(curated);
  publicAuthMismatch.paths["/api/public/generated"] = {
    post: structuredClone(full.paths["/api/public/generated"].post),
  };
  publicAuthMismatch.paths["/api/public/generated"].post[
    "x-postwave-bodyless"
  ] = true;
  assert.equal(
    measureCurated(publicAuthMismatch, manifest).security_exposure_mismatches,
    1,
  );
  const scopeModeMismatch = structuredClone(manifest);
  scopeModeMismatch.routes[0].api_key_scope_mode = "all";
  assert.equal(
    measureCurated(curated, scopeModeMismatch)
      .missing_or_mismatched_scope_modes,
    1,
  );
  const schemaDrift = structuredClone(baseline);
  delete schemaDrift.documents.full.metrics.unresolved_local_refs;
  assert.throws(
    () => validateBaseline(schemaDrift, actual),
    /metric schema drift/u,
  );
  console.log(
    "OpenAPI contract-quality self-tests passed (clean case plus 9 fail-closed mutations).",
  );
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else if (process.argv.includes("--print-current")) {
  if (process.argv.length !== 3) {
    console.error(
      "usage: node scripts/check-openapi-contract-quality.mjs --print-current",
    );
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(measureRepository(), null, 2));
  }
} else if (process.argv.length === 2) {
  const baseline = parseJSON(baselinePath, "OpenAPI contract-quality baseline");
  const actual = measureRepository();
  validateBaseline(baseline, actual);
  console.log("OpenAPI contract-quality ratchet passed.");
  console.log(formatMetrics("full", actual.full));
  console.log(formatMetrics("curated", actual.curated));
} else {
  console.error(
    "usage: node scripts/check-openapi-contract-quality.mjs [--self-test|--print-current]",
  );
  process.exitCode = 2;
}
