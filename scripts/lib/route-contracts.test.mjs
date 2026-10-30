import assert from "node:assert/strict";
import test from "node:test";

import {
  compileRouteContracts,
  contractForRoute,
  validateGatewayOnlyContracts,
} from "./route-contracts.mjs";

const reason = "Reviewed gateway-only contract.";

function patternRule(overrides = {}) {
  return {
    pattern: "^GET /api/internal/",
    exposure: "internal-trust-boundary",
    reason,
    gateway_only_routes: ["GET /api/internal/events"],
    ...overrides,
  };
}

test("exact rules win independently of source order", () => {
  const contracts = compileRouteContracts({
    rules: [
      patternRule({ gateway_only_routes: [] }),
      {
        route: "GET /api/internal/events",
        exposure: "browser-telemetry",
        reason,
      },
    ],
  });
  assert.equal(
    contractForRoute("GET /api/internal/events", contracts)?.exposure,
    "browser-telemetry",
  );
});

test("a new route cannot inherit a broad pattern without reviewed membership", () => {
  const contracts = compileRouteContracts({ rules: [patternRule()] });
  assert.equal(contractForRoute("GET /api/internal/new-route", contracts), null);
  assert.throws(
    () =>
      validateGatewayOnlyContracts({
        contracts,
        gatewayRoutes: [
          "GET /api/internal/events",
          "GET /api/internal/new-route",
        ],
        gatewayOnlyRoutes: [
          "GET /api/internal/events",
          "GET /api/internal/new-route",
        ],
      }),
    /lacks an exact rule or reviewed pattern membership/u,
  );
});

test("stale membership fails after unmount or OpenAPI promotion", () => {
  const contracts = compileRouteContracts({ rules: [patternRule()] });
  assert.throws(
    () =>
      validateGatewayOnlyContracts({
        contracts,
        gatewayRoutes: [],
        gatewayOnlyRoutes: [],
      }),
    /not mounted/u,
  );
  assert.throws(
    () =>
      validateGatewayOnlyContracts({
        contracts,
        gatewayRoutes: ["GET /api/internal/events"],
        gatewayOnlyRoutes: [],
      }),
    /now documented/u,
  );
});

test("membership is sorted, canonical, unique, and matched to its source pattern", () => {
  assert.throws(
    () =>
      compileRouteContracts({
        rules: [
          patternRule({
            gateway_only_routes: [
              "GET /api/internal/z",
              "GET /api/internal/a",
            ],
          }),
        ],
      }),
    /must be sorted/u,
  );
  assert.throws(
    () =>
      compileRouteContracts({
        rules: [
          patternRule({ gateway_only_routes: ["get /api/internal/events"] }),
        ],
      }),
    /canonical METHOD/u,
  );
  assert.throws(
    () =>
      compileRouteContracts({
        rules: [
          patternRule(),
          patternRule({ pattern: "^GET /api/", reason: "Second family." }),
        ],
      }),
    /duplicates membership/u,
  );
  assert.throws(
    () =>
      compileRouteContracts({
        rules: [
          patternRule({ gateway_only_routes: ["GET /api/public/events"] }),
        ],
      }),
    /does not match/u,
  );
});

test("pattern membership may not shadow an exact reviewed rule", () => {
  assert.throws(
    () =>
      compileRouteContracts({
        rules: [
          patternRule(),
          {
            route: "GET /api/internal/events",
            exposure: "browser-telemetry",
            reason,
          },
        ],
      }),
    /shadowed by an exact route rule/u,
  );
});

test("every Handle-style ANY route requires an exact rule", () => {
  const contracts = compileRouteContracts({
    rules: [
      patternRule({
        pattern: "^ANY /api/internal/",
        gateway_only_routes: ["ANY /api/internal/proxy"],
      }),
    ],
  });
  assert.throws(
    () =>
      validateGatewayOnlyContracts({
        contracts,
        gatewayRoutes: ["ANY /api/internal/proxy"],
        gatewayOnlyRoutes: ["ANY /api/internal/proxy"],
      }),
    /method-agnostic route requires an exact contract/u,
  );
});
