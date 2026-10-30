// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageRoot = new URL("../", import.meta.url);
const spec = JSON.parse(readFileSync(new URL("openapi.json", packageRoot), "utf8"));
const embedded = JSON.parse(
  readFileSync(
    new URL("../../apps/api/internal/apidocs/openapi.json", packageRoot),
    "utf8",
  ),
);
const contracts = JSON.parse(
  readFileSync(new URL("route-contracts.json", packageRoot), "utf8"),
);
const routeManifest = JSON.parse(
  readFileSync(
    new URL("../../apps/api/internal/routeauth/manifest.json", packageRoot),
    "utf8",
  ),
);

const held = [
  ["post", "/api/v1/ai-agent/chat"],
  ["get", "/api/v1/ai-agent/config"],
  ["put", "/api/v1/ai-agent/config"],
  ["get", "/api/v1/ai-agent/sessions"],
  ["post", "/api/v1/ai-agent/sessions"],
  ["post", "/api/v1/ai-agent/sessions/{id}/chat"],
  ["get", "/api/v1/ai-agent/sessions/{id}/messages"],
];

test("canonical and embedded OpenAPI expose only the structural 503 hold", () => {
  for (const document of [spec, embedded]) {
    for (const [method, path] of held) {
      const operation = document.paths[path]?.[method];
      assert.ok(operation, `${method.toUpperCase()} ${path} is missing`);
      assert.equal(
        operation["x-postwave-release-hold"],
        "agent_interactive_release_held",
      );
      assert.deepEqual(operation.security, []);
      assert.deepEqual(Object.keys(operation.responses), ["503"]);
      assert.equal(
        operation.responses["503"].$ref,
        "#/components/responses/AgentInteractiveReleaseHeld",
      );
      assert.match(operation.description, /before\s+authentication/iu);
    }
  }
});

test("gateway route contracts and authorization manifest retain the hold", () => {
  for (const [method, path] of [
    ["any", "/api/v1/ai-agent"],
    ["any", "/api/v1/ai-agent/{rest}"],
    ...held,
  ]) {
    const key = `${method.toUpperCase()} ${path}`;
    const contract = contracts.rules.find((candidate) => candidate.route === key);
    assert.ok(contract, `${key} route contract is missing`);
    assert.equal(contract.exposure, "release-held");
    assert.equal(contract.authorization, "pre-auth-release-hold");
    assert.equal(contract.release_hold_code, "agent_interactive_release_held");

    const policy = routeManifest.routes.find(
      (candidate) => candidate.method === method.toUpperCase() && candidate.path === path,
    );
    assert.ok(policy, `${key} route policy is missing`);
    assert.equal(policy.exposure, "release-held");
    assert.deepEqual(policy.auth_methods, ["pre_auth_release_hold"]);
    assert.equal(policy.release_hold_code, "agent_interactive_release_held");
    assert.deepEqual(policy.api_key_scopes, []);
  }
});
