// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const spec = JSON.parse(
  readFileSync(new URL("../openapi.json", import.meta.url), "utf8"),
);

const responseCodes = (operation) => Object.keys(operation.responses).sort();

test("Route39 telemetry has tenant-bound, minimized, admin-only contracts", () => {
  for (const path of [
    "/api/v1/mcp/executions",
    "/api/v1/mcp/stats",
    "/api/v1/mcp/trend",
    "/api/v1/mcp/quotas",
  ]) {
    const get = spec.paths[path]?.get;
    assert.ok(get, `missing GET ${path}`);
    assert.deepEqual(get["x-required-scopes"], ["admin"]);
    assert.equal(get["x-required-role"], "admin");
    assert.deepEqual(get.security, [{ bearerAuth: [] }, { sessionCookie: [] }]);
  }

  const executionEnvelope = spec.components.schemas.MCPExecutionListResponse;
  assert.ok(executionEnvelope.required.includes("tenantId"));
  assert.ok(executionEnvelope.required.includes("rows"));
  assert.equal(
    executionEnvelope.properties.tenantId.format,
    "uuid",
    "empty pages must still carry a canonical tenant binding",
  );
  assert.equal(executionEnvelope.properties.detailPolicy.const, "minimized_v1");
  assert.equal(
    executionEnvelope.properties.evidenceClass.const,
    "best_effort_observability",
  );
});

test("held exports and quota mutations cannot advertise success", () => {
  assert.deepEqual(
    responseCodes(spec.paths["/api/v1/mcp/executions.csv"].get),
    ["401", "403", "503"],
  );
  assert.deepEqual(responseCodes(spec.paths["/api/v1/mcp/quotas"].put), [
    "401",
    "403",
    "503",
  ]);
  assert.deepEqual(
    responseCodes(spec.paths["/api/v1/mcp/quotas/{tool}"].delete),
    ["401", "403", "503"],
  );
  assert.equal(spec.paths["/api/v1/mcp/quotas/*"], undefined);
});

test("execution SSE permits only short stream credentials in URLs", () => {
  const stream = spec.paths["/api/v1/mcp/executions/stream"].get;
  const parameterNames = stream.parameters
    .map((parameter) => parameter.name ?? parameter.$ref)
    .sort();
  assert.deepEqual(parameterNames, [
    "#/components/parameters/MCPInclude",
    "#/components/parameters/MCPTool",
    "Last-Event-ID",
    "sse_token",
    "stream_token",
  ]);
  assert.match(stream.description, /within two minutes/);
  assert.deepEqual(stream.security, [
    { bearerAuth: [] },
    { sessionCookie: [] },
  ]);
  assert.deepEqual(stream["x-postwave-additional-security"], [
    "realtimeStreamTokenQuery",
    "realtimeSSETokenQuery",
  ]);
  assert.equal(spec.components.securitySchemes.realtimeAPIKeyQuery, undefined);
  assert.ok(spec.components.securitySchemes.realtimeStreamTokenQuery);
});

test("native route is explicitly a read-only custom JSON-RPC preview", () => {
  const rpc = spec.paths["/api/v1/mcp/rpc"].post;
  assert.equal(rpc["x-required-auth-method"], "api_key");
  assert.deepEqual(rpc["x-required-scopes"], ["mcp"]);
  assert.deepEqual(rpc.security, [{ bearerAuth: [] }]);
  assert.match(rpc.description, /not qualified MCP Streamable\s+HTTP/);
  assert.match(
    rpc.description,
    /all writes and other PII\/free-text reads are/,
  );
  assert.equal(
    spec.components.schemas.MCPNativeSettings.properties.write_enabled.const,
    false,
  );
  assert.ok(
    spec.components.schemas.MCPNativeCatalogEntry.required.includes(
      "llm_output_safe",
    ),
  );
});

test("API-key self authority is API-key-only and explicitly non-cacheable", () => {
  const self = spec.paths["/api/v1/api-keys/me"].get;
  assert.equal(self["x-required-auth-method"], "api_key");
  assert.deepEqual(self.security, [{ bearerAuth: [] }]);
  assert.ok(self.responses["200"].headers["Cache-Control"]);
  assert.ok(self.responses["200"].headers.Vary);
});
